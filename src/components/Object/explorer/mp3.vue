<script setup lang="ts">
    import { ref, onBeforeMount,nextTick, onMounted,watch } from "vue"
    import {usestore} from '../../../store'
    const store=usestore()
    withDefaults(defineProps<{
            url: string;
            control:string
        }>(),
        {
            url: "",
            control: "完整"
        }
    )
    
    const speedList = [
        {
        label: "<i class='fa fa-step-backward'></i>",
        value: -0.1,
        },
        {
        label: "<i class='fa fa-step-forward'></i>",
        value: +0.1,
        },
    ]
    
    const speedVisible = ref<boolean>(false); // 设置音频播放速度弹窗
    const audioRef = ref(); // 音频标签对象
    const activeSpeed = ref(1); // 音频播放速度
    const audioDuration = ref(0); // 音频总时长
    const audioCurrent = ref(0); // 音频当前播放时间
    const audioVolume = ref(1); // 音频声音，范围 0-1
    const playStatus = ref<boolean>(true); // 音频播放状态：true 播放，false 暂停
    const playProgress = ref(0); // 音频播放进度
    const timeInterval = ref(); // 获取音频播放进度定时器
    const loop = ref<boolean>(false);
    // 音频加载完毕的回调
    const onCanplay = () => {
        audioDuration.value = audioRef?.value.duration || 0;
    }
    const onPlay = async () => {
        // 音频播放完后，重新播放
        if (playProgress.value === 100) audioRef.value.currentTime = 0;
    
        await audioRef.value.play();
        
        playStatus.value = true;
        audioDuration.value = audioRef.value.duration;
    
        timeInterval.value = setInterval(() => {
            if(audioRef.value==null) return
            audioCurrent.value = audioRef.value.currentTime;
            playProgress.value = (audioCurrent.value / audioDuration.value) * 100;
            if (playProgress.value === 100){
                if(loop.value){
                    onPlay()
                }else{
                    onPause()
                }
            };
        }, 100);
    }
    const onPause = () => {
        audioRef.value.pause();
        playStatus.value = false;
        clearInterval(timeInterval.value);
    }
    const onChangeSpeed = (value: number) => {
        activeSpeed.value = Math.max(activeSpeed.value+value,0.1)
        audioRef.value.playbackRate = activeSpeed.value
        speedVisible.value = false
    }
    // 设置声音
    const onSetVolume = (value: number) => {
        audioRef.value.volume = Math.min(Math.max(audioRef.value.volume+value,0),1).toFixed(1);
        audioVolume.value = audioRef.value.volume;
    }
    // 设置进度
    const changeProcess=(e:any) => {
    	const place = e.offsetX/document.getElementById("play-progress")!.offsetWidth*audioRef?.value.duration
        playProgress.value=place/audioRef?.value.duration*100 //进度条
    	audioRef.value.currentTime=place //将播放时间设置为鼠标所在的进度条位置上代表的时间
    }
    // 音频播放时间换算
    const transTime = (value: number) => {
        let time = "";
        let h = parseInt(String(value / 3600));
        value %= 3600;
        let m = parseInt(String(value / 60));
        let s = parseInt(String(value % 60));
        if (h > 0) {
        time = formatTime(h + ":" + m + ":" + s);
        } else {
        time = formatTime(m + ":" + s);
        }
        return time;
    };
    // 格式化时间显示，补零对齐
    const formatTime = (value: string) => {
        let time = "";
        let s = value.split(":");
        let i = 0;
        for (; i < s.length - 1; i++) {
        time += s[i].length == 1 ? "0" + s[i] : s[i];
        time += ":";
        }
        time += s[i].length == 1 ? "0" + s[i] : s[i];
    
        return time;
    };

    //渲染音频
    const RenderAudio= async function() {
        await nextTick()
        var audio = document.getElementById('audio') as HTMLMediaElement
        if(audio==null) return
        var a = new AudioContext();
        var analyser = a.createAnalyser();
        var audioSrc = a.createMediaElementSource(audio);
        // we have to connect the MediaElementSource with the analyser 
        audioSrc.connect(analyser);
        analyser.connect(a.destination);
        // we could configure the analyser: e.g. analyser.fftSize (for further infos read the spec)
        // analyser.fftSize = 64;
        // frequencyBinCount tells you how many values you'll receive from the analyser
        var frequencyData = new Uint8Array(analyser.frequencyBinCount);
    
        // we're ready to receive some data!
        var canvas = document.getElementById('canvas') as any,
            cwidth = canvas.width,
            cheight = canvas.height - 2,
            meterWidth = 15, //width of the meters in the spectrum
            gap = 2, //gap between meters
            capHeight = 2,
            capStyle = document.documentElement.style.getPropertyValue('--fontActiveColor'),
            meterNum = 1000 / (meterWidth + gap), //count of the meters
            capYPositionArray = [] as any; ////store the vertical position of hte caps for the preivous frame
        let ctx = canvas.getContext('2d'),
        gradient = ctx.createLinearGradient(0, 0, 0, 500)
        gradient.addColorStop(1, document.documentElement.style.getPropertyValue('--backgroundColor'))
        gradient.addColorStop(0.98, document.documentElement.style.getPropertyValue('--menuColor'))
        gradient.addColorStop(0.9, document.documentElement.style.getPropertyValue('--fontColor'))
        gradient.addColorStop(0.6, document.documentElement.style.getPropertyValue('--fontActiveColor'))
        // loop
        function renderFrame() {
            var array = new Uint8Array(analyser.frequencyBinCount)
            analyser.getByteFrequencyData(array)
            var step = Math.round(array.length / meterNum) //sample limited data from the total array
            ctx.clearRect(0, 0, cwidth, cheight)
            for (var i = 0; i < meterNum; i++) {
                var value = array[i * step]*1.5
                if (capYPositionArray.length < Math.round(meterNum)) {
                    capYPositionArray.push(value)
                }
                ctx.fillStyle = capStyle
                //draw the cap, with transition effect
                if (value < capYPositionArray[i]) {
                    ctx.fillRect(i * (meterWidth+gap), cheight - (--capYPositionArray[i]), meterWidth, capHeight)
                } else {
                    ctx.fillRect(i * (meterWidth+gap), cheight - value, meterWidth, capHeight)
                    capYPositionArray[i] = value
                }
                ctx.fillStyle = gradient //set the filllStyle to gradient for a better look
                ctx.fillRect(i * (meterWidth+gap) /*meterWidth+gap*/ , cheight - value + capHeight, meterWidth, cheight) //the meter
            }
            requestAnimationFrame(renderFrame)
        }
        renderFrame()
    }
    //监听变化
    watch(()=>store.app.files[store.app.fileIndex], (newValue, oldValue) => {
        if(store.app.files.length>0){
            playStatus.value=false
        }
    })
    onBeforeMount(() => {
        clearInterval(timeInterval.value);
    })
    onMounted(()=>{
        onPlay()
        RenderAudio()
    })
</script>
<template>
    <div class="bg">
    <canvas id='canvas' width="796" height="400"></canvas>
    <div class="audio-player">
        <div class="play-icon" v-if="!playStatus">
            <i class=" fa fa-play" @click="onPlay"></i>
        </div>
        <div class="play-icon" v-if="playStatus">
            <i class="fa fa-pause" @click="onPause"></i>
        </div>
        <span class="play-time" v-if="control=='完整'">
            {{ transTime(audioCurrent) }}/{{ transTime(audioDuration) }}
        </span>
        <div class="play-progress" id="play-progress" @click="changeProcess">
            <div
            class="play-current-progress"
            :style="{ width: `${playProgress}%` }"
            ></div>
        </div>
        <div @click="loop=!loop" class="btn" v-if="control=='完整'">
            <i v-if="loop==true" class="fa fa-circle"></i>
            <i v-if="loop==false" class="fa fa-circle-o"></i>
        </div>
        <div class="btns" v-if="control=='完整'">
            <span>音量：{{ audioVolume }}</span>
            <div @click="audioRef.volume = 0;audioVolume = audioRef.volume" class="btn">
                <i class="fa fa-volume-off"></i>
            </div>
            <div @click="onSetVolume(-0.1)" class="btn">
                <i class="fa fa-volume-down"></i>
            </div>
            <div @click="onSetVolume(0.1)" class="btn">
                <i class="fa fa-volume-up"></i>
            </div>
        </div>
        <div class="btns" v-if="control=='完整'">
            <span>速度：{{ activeSpeed }}</span>
            <div
                v-for="item in speedList"
                :key="item.value"
                @click="onChangeSpeed(item.value)"
                class="btn"
                v-html="item.label">
            </div>
        </div>
    </div>
    <audio id="audio" ref="audioRef" :src="url" @canplay="onCanplay"></audio>
    </div>
</template>
   
<style scoped>
    .bg {
        position: relative;
        width: calc(100%);
        height: calc(100%);
        text-align: left;
    }
    .bg canvas{
        position: absolute;
        width:calc(100%);
        height:calc(100% - 45px);
    }
    .audio-player {
        position: absolute;
        bottom:0px;
        width: calc(100%);
        background-color: var(--menuColor);
        border: 1px solid var(--borderColor);
        height: 45px;
        padding: 10px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        overflow: hidden;
    }
    
    .play-icon {
        position: relative;
        width: 18px;
        height: 22px;
        padding: 8px;
        cursor: pointer;
    }
   
    .play-time {
        position: relative;
        width: 72px;
        display: inline-block;
        margin-right: 30px;
    }
   
    .play-progress {
        position: absolute;
        width: calc(100% - 25px);
        height: 6px;
        background-color: var(--menuActiveColor);
        box-shadow: inset 0px 1px 0px 0px #20222d;
        border-radius: 3px;
        margin-right: 0px;
        position: relative;
    }
    .play-current-progress {
        height: 6px;
        background: var(--fontActiveColor);
        border-radius: 3px;
        position: absolute;
        top: 0;
        left: 0;
    }
    .btns{
        border-left: 1px solid var(--borderColor);
        width:fit-content;
        display: flex;
        margin-left:5px;
        padding-left:5px
    }
    .btn {
        margin-bottom: 0px;
        margin-left: 10px;
        cursor: pointer;
        text-align: center
    }
  </style>