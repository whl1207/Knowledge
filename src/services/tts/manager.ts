// src/services/tts/manager.ts

import { ElMessage } from 'element-plus'
import { getPlatform, hasCapability } from '@/platform'
import { qwen3Synthesize, qwen3ListVoices, resolveQwen3Transport, QWEN3_REFERENCE_VOICE, type Qwen3RequestConfig } from '@/services/tts/qwen3'

// TTS 配置（store 的 tts 对象）→ Qwen3 客户端参数
function qwen3ConfigFrom(ttsConfig: any, timeoutMs: number): Qwen3RequestConfig {
    const q = ttsConfig?.qwen3 || {};
    return {
        base: ttsConfig?.url || '',
        protocol: q.protocol,
        voice: ttsConfig?.voice,
        lang: q.lang ?? ttsConfig?.language,
        modelType: q.modelType,
        speed: q.speed ?? ttsConfig?.rate,
        chunkSize: q.chunkSize,
        batch: q.batch,
        timeoutMs,
    };
}

// 音频队列管理类
class AudioQueue {
    private queue: string[] = [];
    private isPlaying = false;
    private audioElement: HTMLAudioElement | null = null; // 改为单个元素
    private audioURLs: Map<number, string> = new Map();
    private currentIndex = 0;
    private ttsConfig: any;
    private onStateChange?: (state: any) => void;
    private isLocalTTS = false;
    private currentAudioUrl: string | null = null; // 当前音频URL
    private nativeSpeaking = false; // 是否正在用宿主原生语音朗读（安卓系统 TTS）
    private lastHandledErrorIndex: number | null = null; // 防止同一错误被双触发重复消费队列
    private playingIndex: number | null = null; // 当前正在加载/播放的音频序号（onended/onerror 使用）

    constructor(ttsConfig: any, onStateChange?: (state: any) => void) {
        this.ttsConfig = ttsConfig;
        this.onStateChange = onStateChange;
        this.isLocalTTS = ttsConfig.type === "本地";
        
        // 提前创建音频元素
        this.audioElement = new Audio();
        this.setupAudioElement();
    }

    // 设置音频元素
    private setupAudioElement() {
        if (!this.audioElement) return;
        
        console.log(`[AudioQueue] 初始化音频元素`);
        
        const audio = this.audioElement;
        audio.preload = "auto";
        
        // 设置事件监听器
        audio.onended = () => {
            console.log(`[AudioQueue] 音频播放结束 (${this.playingIndex ?? this.currentIndex})`);
            this.handleAudioEnded(this.playingIndex ?? this.currentIndex);
        };
        
        audio.onerror = (error) => {
            const code = audio.error?.code;
            const msg = audio.error?.message || '';
            // cleanup() 重置 src 产生的 "Empty src attribute" 不是真实播放失败，
            // 忽略以免误触发错误处理（否则会与 handleAudioError→cleanup 互相递归成死循环）
            if (code === 4 && !audio.currentSrc) {
                console.log(`[AudioQueue] 忽略空 src 错误（cleanup 产物）`);
                return;
            }
            console.error(`[AudioQueue] 音频播放失败:`, error);
            console.error(`[AudioQueue] 错误代码: ${code}, 消息: ${msg}`);
            this.handleAudioError(this.playingIndex ?? this.currentIndex);
        };
        
        audio.oncanplay = () => {
            console.log(`[AudioQueue] 音频可以播放`);
        };
        
        audio.oncanplaythrough = () => {
            console.log(`[AudioQueue] 音频可以完整播放`);
        };
    }

    // 添加文本到队列
    addToQueue(text: string) {
        const sentences = this.splitTextIntoSentences(text);
        console.log(`[AudioQueue] 添加到队列，分割为 ${sentences.length} 个句子`);
        this.queue.push(...sentences);
        
        if (!this.isPlaying) {
            console.log(`[AudioQueue] 当前未播放，开始播放`);
            this.playNext();
        } else {
            console.log(`[AudioQueue] 正在播放中，预加载下一个`);
            this.preloadNext();
        }
        
        this.notifyStateChange();
    }

    // 智能分割文本
    private splitTextIntoSentences(text: string): string[] {
        const cleanedText = this.cleanTextForTTS(text);
        if (!cleanedText) return [];
        
        // 先按段落分割
        const paragraphs = cleanedText.split(/\n\s*\n/);
        const sentences: string[] = [];
        
        for (const paragraph of paragraphs) {
            const trimmedPara = paragraph.trim();
            if (!trimmedPara) continue;
            
            // 如果段落较短（小于200字符），直接作为一个整体
            if (trimmedPara.length < 200) {
                sentences.push(trimmedPara);
                continue;
            }
            
            // 对于较长段落，按句子分割但保持合并
            const sentenceDelimiters = /([。！？；\.!?;]+)/;
            const parts = trimmedPara.split(sentenceDelimiters);
            let currentChunk = "";
            
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i].trim();
                if (!part) continue;
                
                if (sentenceDelimiters.test(part) && currentChunk) {
                    currentChunk += part;
                    if (currentChunk.length >= 100 || i === parts.length - 1) {
                        sentences.push(currentChunk.trim());
                        currentChunk = "";
                    }
                } else {
                    if (currentChunk.length + part.length < 300) {
                        currentChunk += (currentChunk ? " " : "") + part;
                    } else {
                        if (currentChunk) {
                            sentences.push(currentChunk.trim());
                        }
                        currentChunk = part;
                    }
                }
            }
            
            if (currentChunk) {
                sentences.push(currentChunk.trim());
            }
        }
        
        return sentences.filter(s => s.length > 0);
    }

    // 清理文本
    private cleanTextForTTS(input: string): string {
        return input
            .replace(/^---[\s\S]*?---\n?/gm, '')
            .replace(/[>#*:|"'-]/g, " ")
            .replace(/\s+/g, " ")
            .replace(/```[\s\S]*?```/g, " ")
            .replace(/`[^`]+`/g, " ")
            .replace(/!\[.*?\]\(.*?\)/g, " ")
            .replace(/\[.*?\]\(.*?\)/g, " ")
            .replace(/<[^>]+>/g, " ")
            .trim();
    }

    // 预加载下一段音频
    private async preloadNext() {
        const nextIndex = this.currentIndex;
        const nextText = this.queue[0];
        
        if (!nextText || this.audioURLs.has(nextIndex) || this.isLocalTTS) {
            return;
        }
        
        try {
            console.log(`[AudioQueue] 预加载音频 (${nextIndex})`);
            const audioUrl = await this.fetchAudio(nextText, nextIndex);
            if (audioUrl) {
                this.audioURLs.set(nextIndex, audioUrl);
                console.log(`[AudioQueue] 预加载成功 (${nextIndex})`);
            } else {
                console.error(`[AudioQueue] 预加载失败 (${nextIndex})`);
            }
        } catch (error) {
            console.error(`[AudioQueue] 预加载音频失败 (${nextIndex}):`, error);
        }
    }

    // 播放下一段
    private async playNext() {
        if (this.queue.length === 0) {
            console.log(`[AudioQueue] 队列为空，停止播放`);
            this.isPlaying = false;
            this.cleanup();
            this.notifyStateChange();
            return;
        }
        
        console.log(`[AudioQueue] 开始播放第${this.currentIndex}段音频，队列长度: ${this.queue.length}`);
        
        this.isPlaying = true;
        const text = this.queue[0];
        const currentPlayIndex = this.currentIndex;
        
        try {
            if (this.isLocalTTS) {
                console.log(`[AudioQueue] 使用本地TTS播放: ${text.substring(0, 50)}...`);
                this.playLocalTTS(text);
                return;
            }
            
            let audioUrl = this.audioURLs.get(currentPlayIndex) as any;
            
            if (!audioUrl) {
                console.log(`[AudioQueue] 获取音频URL (${currentPlayIndex})`);
                audioUrl = await this.fetchAudio(text, currentPlayIndex);
                if (!audioUrl) {
                    console.error(`[AudioQueue] 获取音频URL失败 (${currentPlayIndex})`);
                    this.queue.shift();
                    this.currentIndex++;
                    this.notifyStateChange();
                    setTimeout(() => this.playNext(), 100);
                    return;
                }
                this.audioURLs.set(currentPlayIndex, audioUrl);
                console.log(`[AudioQueue] 获取音频URL成功 (${currentPlayIndex})`);
            }
            
            // 清理之前的音频URL
            if (this.currentAudioUrl) {
                this.cleanupAudioURLByUrl(this.currentAudioUrl);
            }
            
            console.log(`[AudioQueue] 设置音频源`);
            
            // 使用现有的音频元素
            if (!this.audioElement) {
                this.audioElement = new Audio();
                this.setupAudioElement();
            }
            
            const audio = this.audioElement;
            this.currentAudioUrl = audioUrl;
            this.playingIndex = currentPlayIndex;
            
            // 重置音频状态
            audio.pause();
            audio.currentTime = 0;
            
            // 设置新的音频源
            console.log(`[AudioQueue] 设置音频源: ${audioUrl.substring(0, 50)}...`);
            audio.src = audioUrl;
            
            // 等待音频加载
            await new Promise<void>((resolve, reject) => {
                const onCanPlay = () => {
                    console.log(`[AudioQueue] 音频准备就绪，开始播放`);
                    audio.removeEventListener('canplay', onCanPlay);
                    audio.removeEventListener('error', onError);
                    resolve();
                };
                
                const onError = (error: Event) => {
                    console.error(`[AudioQueue] 音频加载失败`);
                    audio.removeEventListener('canplay', onCanPlay);
                    audio.removeEventListener('error', onError);
                    reject(new Error(`音频加载失败: ${error}`));
                };
                
                audio.addEventListener('canplay', onCanPlay, { once: true });
                audio.addEventListener('error', onError, { once: true });
                
                audio.load();
            });
            
            // 尝试播放
            console.log(`[AudioQueue] 开始播放音频`);
            const playPromise = audio.play();
            
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    console.log(`[AudioQueue] 播放成功`);
                }).catch(error => {
                    console.error(`[AudioQueue] 播放失败:`, error);
                    // 可能是浏览器自动播放策略限制
                    this.handleAudioError(currentPlayIndex);
                });
            }
            
            // 更新状态
            this.queue.shift();
            this.currentIndex++;
            this.notifyStateChange();
            
            // 预加载下一个
            this.preloadNext();
            
        } catch (error) {
            console.error(`[AudioQueue] 处理音频播放失败 (${currentPlayIndex}):`, error);
            this.handleAudioError(currentPlayIndex);
        }
    }

    // 处理音频播放结束
    private handleAudioEnded(index: number) {
        console.log(`[AudioQueue] 处理音频播放结束 (${index})`);
        
        // 清理已播放的音频URL
        this.cleanupAudioURL(index);
        
        this.notifyStateChange();
        
        // 检查是否还有后续内容
        if (this.queue.length > 0) {
            // 增加延迟，确保音频完全结束
            setTimeout(() => {
                this.playNext();
            }, 300); // 增加到300ms延迟
        } else {
            this.isPlaying = false;
            // 延迟清理，避免干扰当前播放
            setTimeout(() => {
                this.cleanup();
                this.notifyStateChange();
            }, 500);
        }
    }

    // 处理音频错误
    private handleAudioError(index: number) {
        console.log(`[AudioQueue] 处理音频错误 (${index})`);
        // 同一个错误会被 audio.onerror 与 play 失败 Promise 双触发：
        // 若已处理过该序号则直接忽略，避免队列被重复消费、多个 playNext
        // 并发竞态（一个在播放、另一个被 cleanup 清空 src → "Empty src" 循环）
        if (this.lastHandledErrorIndex === index) {
            console.log(`[AudioQueue] 忽略重复错误处理 (${index})`);
            return;
        }
        this.lastHandledErrorIndex = index;
        this.cleanupAudioURL(index);
        
        // 如果当前片段失败，尝试处理下一段
        if (this.queue.length > 0) {
            this.queue.shift();
            this.currentIndex++;
            this.notifyStateChange();
            setTimeout(() => this.playNext(), 300);
        } else {
            this.isPlaying = false;
            this.cleanup();
            this.notifyStateChange();
        }
    }

    // 获取音频
    private async fetchAudio(text: string, index: number): Promise<string | null> {
        const ttsConfig = this.ttsConfig;
        
        if (ttsConfig.type === "indexTTS2") {
            return await this.fetchIndexTTS2Audio(text, index);
        } else if (ttsConfig.type === "Qwen3-TTS") {
            return await this.fetchQwen3TTSAudio(text, index);
        } else if (ttsConfig.type === "Kokoro" || ttsConfig.type === "Piper") {
            return await this.fetchOnnxTTSAudio(text, index);
        }
        
        return null;
    }

    // 本地 ONNX TTS（Kokoro / Piper）— 通过宿主合成 WAV 后播放（桌面 = 主进程 sherpa-onnx；安卓不支持）
    private async fetchOnnxTTSAudio(text: string, index: number): Promise<string | null> {
        const ttsConfig = this.ttsConfig;
        try {
            const tts = getPlatform().host.tts
            if (!hasCapability('host.tts')) {
                console.error("[ONNX-TTS] 当前环境不提供本地语音合成");
                return null;
            }
            console.log(`[ONNX-TTS] 开始合成 (${index}): ${text.substring(0, 50)}...`);
            const wav = await tts.synthesize({
                engine: ttsConfig.type, // 'Kokoro' | 'Piper'
                modelDir: ttsConfig.onnx?.modelDir || '',
                text,
                sid: ttsConfig.onnx?.sid ?? 0,
                speed: ttsConfig.onnx?.speed ?? 1.0,
                lang: ttsConfig.onnx?.lang || undefined,
            })
            if (!wav || wav.byteLength === 0) {
                console.error("[ONNX-TTS] 合成结果为空");
                return null;
            }
            const blob = new Blob([wav], { type: 'audio/wav' })
            const url = URL.createObjectURL(blob)
            console.log(`[ONNX-TTS] 合成成功 (${index}) ${blob.size} bytes`);
            return url
        } catch (error: any) {
            console.error(`[ONNX-TTS] 合成失败 (${index}):`, error?.message || error);
            return null;
        }
    }

    // 本地TTS：优先用宿主原生语音（安卓系统 TTS），其次用浏览器 Web Speech
    private playLocalTTS(text: string) {
        console.log(`[LocalTTS] 开始播放本地TTS: ${text.substring(0, 50)}...`);
        const ttsConfig = this.ttsConfig;
        const finishLocal = () => {
            this.queue.shift();
            this.currentIndex++;
            this.notifyStateChange();
            setTimeout(() => this.playNext(), 100);
        }

        // 安卓：Android WebView 没有 speechSynthesis，走原生系统 TTS（宿主直接朗读，读完 resolve）
        if (!this.hasWebSpeech()) {
            void this.speakViaHost(text, finishLocal);
            return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        
        if (ttsConfig.voice) {
            const voices = window.speechSynthesis.getVoices();
            const selectedVoice = voices.find(voice => 
                voice.name.includes(ttsConfig.voice) || 
                voice.lang.includes(ttsConfig.voice)
            );
            if (selectedVoice) {
                utterance.voice = selectedVoice;
                console.log(`[LocalTTS] 使用语音: ${selectedVoice.name}`);
            }
        }
        
        utterance.rate = ttsConfig.rate || 1.0;
        utterance.pitch = ttsConfig.pitch || 1.0;
        
        // 保存当前utterance的引用
        const currentUtterance = utterance;
        
        utterance.onstart = () => {
            console.log(`[LocalTTS] 开始播放`);
        };
        
        utterance.onend = () => {
            console.log(`[LocalTTS] 播放结束`);
            // 确保是当前utterance结束时才处理
            if (currentUtterance === utterance) {
                this.queue.shift();
                this.currentIndex++;
                this.notifyStateChange();
                setTimeout(() => this.playNext(), 100);
            }
        };
        
        utterance.onerror = (event) => {
            console.error("[LocalTTS] 错误:", event);
            if (currentUtterance === utterance) {
                this.queue.shift();
                this.currentIndex++;
                this.notifyStateChange();
                setTimeout(() => this.playNext(), 100);
            }
        };
        
        window.speechSynthesis.speak(utterance);
    }

    /** 浏览器 / Electron 才有 Web Speech；Android WebView 没有，需要走宿主原生语音 */
    private hasWebSpeech(): boolean {
        return typeof window !== 'undefined' && typeof (window as any).speechSynthesis?.speak === 'function'
    }

    /** Web Speech 实例（安卓上没有 → null，所有调用点都必须经它兜底） */
    private webSpeech(): any {
        return this.hasWebSpeech() ? (window as any).speechSynthesis : null
    }

    /**
     * 用宿主原生语音朗读一句（安卓系统 TTS）：读完（或被打断）后推进队列。
     * 失败时按「跳过本句」处理，避免一个引擎问题卡死整个播放队列。
     */
    private async speakViaHost(text: string, done: () => void): Promise<void> {
        const ttsConfig = this.ttsConfig;
        this.nativeSpeaking = true;
        try {
            if (!hasCapability('host.tts')) {
                console.error('[LocalTTS] 当前环境既没有 Web Speech 也没有原生语音');
                ElMessage.warning('当前环境不支持语音朗读')
                done()
                return
            }
            const res = await getPlatform().host.tts.speak({
                text,
                rate: ttsConfig.rate || 1.0,
                pitch: ttsConfig.pitch || 1.0,
                voice: ttsConfig.voice || undefined,
                lang: ttsConfig.language || undefined,
            })
            if (!res?.success && res?.error && res.error !== 'stopped') {
                console.error('[LocalTTS] 原生语音失败:', res.error);
            }
        } catch (e: any) {
            console.error('[LocalTTS] 原生语音异常:', e?.message || e);
        } finally {
            this.nativeSpeaking = false;
            // 已被 stop() 清空队列时不再推进
            if (this.queue.length) done()
        }
    }

    // 获取indexTTS2音频
    private async fetchIndexTTS2Audio(text: string, index: number): Promise<string | null> {
        const ttsConfig = this.ttsConfig;
        
        if (!ttsConfig.url) {
            console.error("[indexTTS2] TTS URL未配置");
            return null;
        }
        
        let controller: AbortController | null = null;
        let timeoutId: any = null;
        
        try {
            console.log(`[indexTTS2] 开始获取音频 (${index}): ${text.substring(0, 50)}...`);
            
            const url = new URL(ttsConfig.url);
            // 不要使用encodeURIComponent，URL构造函数会自动编码
            url.searchParams.set('text', text);
            
            if (ttsConfig.voice) {
                url.searchParams.set('speaker', ttsConfig.voice);
            }
            
            if (ttsConfig.language) {
                url.searchParams.set('lang', ttsConfig.language);
            }
            
            const emo = ttsConfig.emo;
            if (emo) {
                url.searchParams.set('emo', emo);
            }
            
            const weight = ttsConfig.weight;
            if (weight) {
                url.searchParams.set('weight', weight.toString());
            }
            
            console.log(`[indexTTS2] 请求URL: ${url.toString()}`);
            
            // 创建控制器和超时 - 120秒
            controller = new AbortController();
            timeoutId = setTimeout(() => {
                console.log(`[indexTTS2] 请求超时 (${index}) - 120秒`);
                if (controller) {
                    controller.abort();
                }
            }, 120000);
            
            const startTime = Date.now();
            console.log(`[indexTTS2] 开始请求 (${index})`);
            
            const response = await fetch(url.toString(), {
                signal: controller.signal,
                headers: { 
                    'Accept': 'audio/wav, audio/mpeg, audio/*',
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            
            const endTime = Date.now();
            console.log(`[indexTTS2] 请求完成 (${index})，耗时: ${endTime - startTime}ms`);
            
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            
            console.log(`[indexTTS2] 响应状态: ${response.status} ${response.statusText}`);
            
            if (!response.ok) {
                console.error(`[indexTTS2] HTTP错误! 状态码: ${response.status}`);
                return null;
            }
            
            const contentType = response.headers.get('content-type') || '';
            console.log(`[indexTTS2] 响应类型: ${contentType}`);
            
            const audioBlob = await response.blob();
            console.log(`[indexTTS2] 音频大小: ${audioBlob.size} bytes`);
            
            if (audioBlob.size === 0) {
                console.error("[indexTTS2] 音频响应为空");
                return null;
            }
            
            const audioUrl = URL.createObjectURL(audioBlob);
            console.log(`[indexTTS2] 创建音频URL成功: ${audioUrl.substring(0, 50)}...`);
            
            return audioUrl;
            
        } catch (error: any) {
            console.error(`[indexTTS2] 获取音频失败 (${index}):`, error);
            
            if (error.name === 'AbortError') {
                console.error(`[indexTTS2] 请求被取消/超时 (${index})`);
            }
            
            // 清理超时
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            
            return null;
        } finally {
            // 确保清理超时
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    // Qwen3-TTS 请求配置（把 store 里的 tts/qwen3 配置整理成客户端参数）
    private qwen3RequestConfig(timeoutMs: number): Qwen3RequestConfig {
        return qwen3ConfigFrom(this.ttsConfig, timeoutMs);
    }

    // 获取 Qwen3-TTS 音频（Gradio /do_job 或直连接口一次 POST，见 services/tts/qwen3.ts）
    private async fetchQwen3TTSAudio(text: string, index: number): Promise<string | null> {
        if (!this.ttsConfig.url) {
            console.error("[Qwen3-TTS] TTS URL 未配置");
            return null;
        }
        const startTime = Date.now();
        try {
            console.log(`[Qwen3-TTS] 开始获取音频 (${index}): ${text.substring(0, 50)}...`);
            const res = await qwen3Synthesize(this.qwen3RequestConfig(180000), text);
            console.log(`[Qwen3-TTS] 合成完成 (${index})，耗时 ${Date.now() - startTime}ms，${res.transport} · ${res.mime} · ${res.buffer.byteLength} bytes`);
            return URL.createObjectURL(new Blob([res.buffer], { type: res.mime || 'audio/wav' }));
        } catch (error: any) {
            console.error(`[Qwen3-TTS] 获取音频失败 (${index}):`, error?.message || error);
            console.error('[Qwen3-TTS] 请检查：1) 服务是否启动（Gradio 7862 / 直连接口 9880）2) 服务地址是否正确 3) 是否已在设置里选择音色');
            return null;
        }
    }

    // 通过URL清理音频
    private cleanupAudioURLByUrl(url: string) {
        if (!url) return;
        
        try {
            console.log(`[AudioQueue] 清理音频URL: ${url.substring(0, 50)}...`);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error(`[AudioQueue] 清理音频URL失败:`, error);
        }
    }

    // 清理音频URL
    private cleanupAudioURL(index: number) {
        const url = this.audioURLs.get(index);
        if (url) {
            try {
                console.log(`[AudioQueue] 清理音频URL (${index})`);
                URL.revokeObjectURL(url);
            } catch (error) {
                console.error(`[AudioQueue] 清理音频URL失败 (${index}):`, error);
            }
            this.audioURLs.delete(index);
        }
    }

    // 停止当前音频
    private stopCurrentAudio() {
        if (this.audioElement) {
            try {
                console.log(`[AudioQueue] 停止当前音频`);
                this.audioElement.pause();
                this.audioElement.currentTime = 0;
                
                // 清理当前URL
                if (this.currentAudioUrl) {
                    this.cleanupAudioURLByUrl(this.currentAudioUrl);
                    this.currentAudioUrl = null;
                }
            } catch (error) {
                console.error("[AudioQueue] 停止音频时出错:", error);
            }
        }
    }

    // 清理资源
    private cleanup() {
        console.log(`[AudioQueue] 清理所有资源`);
        
        // 停止音频
        this.stopCurrentAudio();
        
        // 清理音频元素（用 removeAttribute 避免触发 "Empty src" 错误事件）
        if (this.audioElement) {
            try {
                this.audioElement.removeAttribute('src');
                this.audioElement.load();
            } catch (error) {
                console.error("[AudioQueue] 清理音频元素时出错:", error);
            }
        }
        
        // 清理所有音频URL
        for (const [index, url] of this.audioURLs.entries()) {
            try {
                URL.revokeObjectURL(url);
            } catch (error) {
                console.error(`[AudioQueue] 清理音频URL失败 (${index}):`, error);
            }
        }
        this.audioURLs.clear();
        
        // 重置状态
        this.queue = [];
        this.isPlaying = false;
        this.currentIndex = 0;
        this.currentAudioUrl = null;
        this.playingIndex = null;
        this.lastHandledErrorIndex = null;
    }

    // 停止播放
    stop() {
        console.log(`[AudioQueue] 停止播放`);
        // 如果是本地TTS，停止语音合成
        if (this.isLocalTTS) {
            if (this.hasWebSpeech()) window.speechSynthesis.cancel();
            if (this.nativeSpeaking || hasCapability('host.tts')) {
                void getPlatform().host.tts.stop().catch(() => {});
            }
        }
        
        this.cleanup();
        this.notifyStateChange();
    }

    // 获取状态
    getStatus() {
        return {
            isPlaying: this.isPlaying,
            queueLength: this.queue.length,
            currentIndex: this.currentIndex
        };
    }

    // 通知状态变化
    private notifyStateChange() {
        if (this.onStateChange) {
            this.onStateChange(this.getState());
        }
    }

    // 获取完整状态
    getState() {
        return {
            ...this.getStatus(),
            isLocalTTS: this.isLocalTTS,
            currentAudio: this.audioElement,
            currentAudioUrl: this.currentAudioUrl
        };
    }
}

// TTS管理器主类
export class TTSManager {
    private audioQueue: AudioQueue | null = null;
    private ttsConfig: any;
    private onStateChangeCallback?: (state: any) => void;

    constructor(ttsConfig: any, onStateChange?: (state: any) => void) {
        this.ttsConfig = ttsConfig;
        this.onStateChangeCallback = onStateChange;
    }

    // 更新配置
    updateConfig(ttsConfig: any) {
        console.log(`[TTSManager] 更新配置:`, ttsConfig);
        this.ttsConfig = ttsConfig;
    }

    // 播放TTS
    async play(text: string) {
        console.log(`[TTSManager] 播放TTS: ${text.substring(0, 50)}...`);
        
        // 停止之前的TTS
        this.stop();
        
        // 创建新的音频队列
        this.audioQueue = new AudioQueue(this.ttsConfig, (state) => {
            console.log(`[TTSManager] 队列状态变化:`, state);
            if (this.onStateChangeCallback) {
                const ttsState = this.getTTSState();
                this.onStateChangeCallback({
                    ...ttsState,
                    queueState: state
                });
            }
        });
        
        // 添加文本到队列
        this.audioQueue.addToQueue(text);
    }

    // 停止TTS
    stop() {
        console.log(`[TTSManager] 停止TTS`);
        // 停止本地TTS（浏览器 Web Speech / 安卓系统 TTS）
        if (this.ttsConfig.type === "本地") {
            if (typeof (window as any).speechSynthesis?.cancel === 'function') (window as any).speechSynthesis.cancel();
            if (hasCapability('host.tts')) void getPlatform().host.tts.stop().catch(() => {});
        }
        
        // 停止音频队列
        if (this.audioQueue) {
            this.audioQueue.stop();
            this.audioQueue = null;
        }
        
        // 清理资源
        this.cleanupTTSResources();
        
        // 通知状态变化
        if (this.onStateChangeCallback) {
            this.onStateChangeCallback(this.getTTSState());
        }
    }

    /** Web Speech 实例（安卓 WebView 没有 speechSynthesis → null，调用点必须兜底） */
    private webSpeech(): any {
        return typeof window !== 'undefined' && typeof (window as any).speechSynthesis?.speak === 'function'
            ? (window as any).speechSynthesis
            : null
    }

    // 获取TTS状态
    getTTSState() {
        let queueState = { 
            isPlaying: false, 
            queueLength: 0, 
            currentIndex: 0 
        };
        
        if (this.audioQueue) {
            queueState = this.audioQueue.getStatus();
        }
        
        if (this.ttsConfig.type === "本地") {
            const web = this.webSpeech();
            return {
                // 安卓 WebView 没有 Web Speech（走系统 TTS），此时以队列播放状态为准
                isSpeaking: !!web?.speaking || queueState.isPlaying,
                isPaused: !!web?.paused,
                queueLength: queueState.queueLength,
                type: 'local'
            };
        } else if (this.ttsConfig.type === "Kokoro" || this.ttsConfig.type === "Piper") {
            return {
                isSpeaking: queueState.isPlaying,
                isPaused: false,
                queueLength: queueState.queueLength,
                type: 'local'
            };
        } else if (this.ttsConfig.type === "indexTTS2" || this.ttsConfig.type === "Qwen3-TTS") {
            return {
                isSpeaking: queueState.isPlaying,
                isPaused: false,
                queueLength: queueState.queueLength,
                type: 'remote'
            };
        }
        
        return { 
            isSpeaking: false, 
            isPaused: false, 
            queueLength: 0,
            type: 'unknown' 
        };
    }

    // 清理TTS资源
    private cleanupTTSResources() {
        console.log(`[TTSManager] 清理TTS资源`);
        // 清理所有blob URL
        document.querySelectorAll('audio[src^="blob:"]').forEach(audio => {
            try {
                const audioElement = audio as HTMLAudioElement;
                audioElement.pause();
                audioElement.src = '';
                audioElement.load();
            } catch (error) {
                // 静默处理错误
            }
        });
    }

    // 暂停/恢复TTS
    togglePause() {
        console.log(`[TTSManager] 切换暂停/恢复状态`);
        if (this.ttsConfig.type === "本地") {
            const web = this.webSpeech();
            // 安卓走系统 TTS，没有 pause/resume 能力（要停只能 stop），这里静默忽略
            if (web?.speaking) {
                if (web.paused) {
                    web.resume();
                    console.log(`[TTSManager] 恢复本地TTS`);
                } else {
                    web.pause();
                    console.log(`[TTSManager] 暂停本地TTS`);
                }
            }
        }
        
        // 通知状态变化
        if (this.onStateChangeCallback) {
            this.onStateChangeCallback(this.getTTSState());
        }
    }

    // 测试 Qwen3-TTS 连接：探测接口类型（Gradio /do_job 或直连接口），顺带拉一次音色列表
    async testQwen3TTSConnection(): Promise<{
        success: boolean;
        message: string;
        details?: any;
    }> {
        console.log(`[TTSManager] 测试Qwen3-TTS连接`);
        if (!this.ttsConfig.url) {
            return {
                success: false,
                message: "Qwen3-TTS 服务地址未配置"
            };
        }

        const base = this.ttsConfig.url;
        const protocol = this.ttsConfig.qwen3?.protocol;
        try {
            const resolved = await resolveQwen3Transport({ base, protocol });
            let voices: string[] = [];
            let voiceError = '';
            try {
                const listed = await qwen3ListVoices({ base, protocol });
                voices = listed.voices.filter(v => v !== QWEN3_REFERENCE_VOICE);
            } catch (e: any) {
                voiceError = e?.message || String(e);
            }

            const label = resolved.transport === 'gradio' ? 'Gradio /do_job' : '直连接口（一次 POST）';
            const parts = [`连接成功 · ${label}`, `地址 ${resolved.base}`];
            if (voices.length) parts.push(`${voices.length} 个音色`);
            if (voiceError) parts.push(`音色列表不可用：${voiceError.slice(0, 100)}`);

            return {
                success: true,
                message: parts.join(' · '),
                details: {
                    transport: resolved.transport,
                    base: resolved.base,
                    gradioBase: resolved.gradioBase,
                    voices,
                    voiceError: voiceError || undefined,
                }
            };
        } catch (error: any) {
            console.error("[TTSManager] 测试Qwen3-TTS连接失败:", error);
            let message = error?.message || String(error);
            if (error?.name === 'TypeError' && String(message).includes('Failed to fetch')) {
                message = '网络错误，请检查服务是否运行、地址是否正确';
            }
            return {
                success: false,
                message: `连接失败：${message}`,
                details: { error: String(error) }
            };
        }
    }

    // 测试Qwen3-TTS直接播放
    async testQwen3TTSDirectly(text: string = "测试一下Qwen3语音合成") {
        if (this.ttsConfig.type !== "Qwen3-TTS") {
            console.error("[TTSManager] 当前配置不是Qwen3-TTS");
            ElMessage.warning("当前配置不是Qwen3-TTS");
            return;
        }
        
        console.log(`[TTSManager] 直接测试Qwen3-TTS: ${text}`);
        
        try {
            const audioUrl = await this.fetchQwen3TTSAudioDirectly(text);
            if (audioUrl) {
                console.log(`[TTSManager] 音频URL获取成功`);
                
                const audio = new Audio();
                audio.src = audioUrl;
                audio.controls = true; // 添加控制条便于调试
                
                // 添加到页面以便调试
                audio.style.position = 'fixed';
                audio.style.bottom = '10px';
                audio.style.right = '10px';
                audio.style.zIndex = '10000';
                audio.style.width = '300px';
                audio.style.backgroundColor = 'white';
                audio.style.border = '2px solid #007bff';
                audio.style.borderRadius = '5px';
                audio.style.padding = '5px';
                document.body.appendChild(audio);
                
                // 添加标题
                const title = document.createElement('div');
                title.textContent = 'Qwen3-TTS测试播放器';
                title.style.position = 'fixed';
                title.style.bottom = '70px';
                title.style.right = '10px';
                title.style.zIndex = '10001';
                title.style.backgroundColor = '#007bff';
                title.style.color = 'white';
                title.style.padding = '5px 10px';
                title.style.borderRadius = '3px';
                title.style.fontSize = '12px';
                document.body.appendChild(title);
                
                audio.play().then(() => {
                    console.log(`[TTSManager] 音频开始播放`);
                }).catch(error => {
                    console.error(`[TTSManager] 播放失败:`, error);
                    ElMessage.warning(`播放失败: ${error.message}\n请点击音频控件手动播放。`);
                });
                
                // 播放结束后移除
                audio.onended = () => {
                    console.log(`[TTSManager] 音频播放结束`);
                    setTimeout(() => {
                        if (document.body.contains(audio)) {
                            document.body.removeChild(audio);
                        }
                        if (document.body.contains(title)) {
                            document.body.removeChild(title);
                        }
                        URL.revokeObjectURL(audioUrl);
                    }, 2000);
                };
                
                // 添加错误处理
                audio.onerror = (error) => {
                    console.error(`[TTSManager] 音频播放错误:`, error);
                    ElMessage.error(`音频播放错误\n请检查音频格式是否被浏览器支持。`);
                };
            } else {
                console.error(`[TTSManager] 获取音频失败`);
                ElMessage.error('获取音频失败，请检查服务器连接和配置。\n1. 确保Qwen3-TTS服务器正在运行\n2. 检查URL配置\n3. 检查网络连接');
            }
        } catch (error: any) {
            console.error(`[TTSManager] 测试失败:`, error);
            ElMessage.error(`测试失败: ${error.message}`);
        }
    }

    // 直接获取Qwen3-TTS音频（调试用：与播放队列同一条合成路径）
    private async fetchQwen3TTSAudioDirectly(text: string): Promise<string | null> {
        if (!this.ttsConfig.url) return null;
        try {
            const res = await qwen3Synthesize(qwen3ConfigFrom(this.ttsConfig, 180000), text);
            return URL.createObjectURL(new Blob([res.buffer], { type: res.mime || 'audio/wav' }));
        } catch (error: any) {
            console.error('[TTSManager] 直接获取Qwen3-TTS音频失败:', error?.message || error);
            return null;
        }
    }

    // 获取默认声音列表
    getDefaultVoices(): string[] {
        return [
            '四川方言',
            '普通话',
            '粤语',
            '东北话',
            '台湾腔',
            '英文',
            '日语',
            '韩语',
            '温柔女声',
            '成熟男声',
            '可爱童声'
        ];
    }

    // 设置语速
    setRate(rate: number) {
        console.log(`[TTSManager] 设置语速: ${rate}`);
        this.ttsConfig.rate = rate;
    }

    // 设置音高
    setPitch(pitch: number) {
        console.log(`[TTSManager] 设置音高: ${pitch}`);
        this.ttsConfig.pitch = pitch;
    }

    // 设置声音
    setVoice(voice: string) {
        console.log(`[TTSManager] 设置声音: ${voice}`);
        this.ttsConfig.voice = voice;
    }

    // 设置语言
    setLanguage(language: string) {
        console.log(`[TTSManager] 设置语言: ${language}`);
        this.ttsConfig.language = language;
    }

    // 设置情感
    setEmotion(emo: string) {
        console.log(`[TTSManager] 设置情感: ${emo}`);
        this.ttsConfig.emo = emo;
    }

    // 设置权重
    setWeight(weight: number) {
        console.log(`[TTSManager] 设置权重: ${weight}`);
        this.ttsConfig.weight = weight;
    }
}

// 导出默认实例（如果需要单例模式）
export const createTTSManager = (config: any, onStateChange?: (state: any) => void) => {
    return new TTSManager(config, onStateChange);
};