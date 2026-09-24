/**
 * useChatModels.ts — 模型配置 / 连接检测 / 模型刷新（从 home.vue 抽出）
 *
 * 依赖注入：store、getCurrentChat、saveChats、getDefaultModel。
 * 返回：连接状态 refs + 全部模型相关函数（home.vue 解构后模板与既有调用点不变）。
 */

import { ref } from 'vue'
import { usestore } from '@/store'
import { deepSeekModel, setDeepSeekModel } from '@/shared/llmSources'
import type { ChatConfig } from '@/types/chat'

export interface ChatModelsDeps {
  getCurrentChat: () => { config: ChatConfig; online?: boolean }
  saveChats: () => void
  /** customIndex 用于自定义来源（llmType='custom' 时取该来源默认模型） */
  getDefaultModel: (llmType: string, customIndex?: number) => string
}

export function useChatModels(deps: ChatModelsDeps) {
  const store = usestore()
  const { getCurrentChat, saveChats, getDefaultModel } = deps

  // ---------------- 连接测试状态 ----------------

  const connectionTestStatus = ref('')
  const connectionTestIcon = ref('')
  const connectionTestClass = ref('')
  const connectionTestTimeout = ref<ReturnType<typeof setTimeout> | null>(null)

  const setConnectionTestStatus = (status: string, isSuccess: boolean) => {
    if (connectionTestTimeout.value) {
      clearTimeout(connectionTestTimeout.value)
      connectionTestTimeout.value = null
    }
    connectionTestStatus.value = status
    if (isSuccess) {
      connectionTestIcon.value = 'fa fa-check-circle'
      connectionTestClass.value = 'step-success'
    } else {
      connectionTestIcon.value = 'fa fa-times-circle'
      connectionTestClass.value = 'step-error'
    }
    connectionTestTimeout.value = setTimeout(() => {
      connectionTestStatus.value = ''
      connectionTestTimeout.value = null
    }, 5000)
  }

  // ---------------- 模型配置读写 ----------------

  /** 把聊天级模型配置写回全局 store（供 AIUtils 读取） */
  const updateStoreModelConfig = (config: ChatConfig) => {
    const llmConfig = store.AIconfig.llm
    switch (config.llmType) {
      case 'ollama':
        llmConfig.ollama.model = config.model
        break
      case 'lmstudio':
        if (llmConfig.lmstudio) llmConfig.lmstudio.model = config.model
        break
      case 'openai':
        llmConfig.openai.model = config.model
        break
      case 'deepseek':
        // 单来源：模型写回当前接口样式对应的配置块
        setDeepSeekModel(llmConfig, config.model)
        break
      case 'anthropic':
        llmConfig.anthropic.model = config.model
        break
      case 'google':
        llmConfig.google.model = config.model
        break
      case 'azure':
        llmConfig.azure.deployment = config.model
        break
      case 'custom':
        llmConfig.custom.model = config.model
        break
    }
    llmConfig.temperature = config.temperature
    llmConfig.max_tokens = config.maxTokens
    llmConfig.stream = config.stream
  }

  /** 恢复全局 store 的模型配置（连接测试后还原） */
  const restoreStoreModelConfig = (type: string, model: string) => {
    const llmConfig = store.AIconfig.llm
    switch (type) {
      case 'ollama':
        llmConfig.ollama.model = model
        break
      case 'lmstudio':
        if (llmConfig.lmstudio) llmConfig.lmstudio.model = model
        break
      case 'openai':
        llmConfig.openai.model = model
        break
      case 'deepseek':
        setDeepSeekModel(llmConfig, model)
        break
      case 'anthropic':
        llmConfig.anthropic.model = model
        break
      case 'google':
        llmConfig.google.model = model
        break
      case 'azure':
        llmConfig.azure.deployment = model
        break
      case 'custom':
        llmConfig.custom.model = model
        break
    }
  }

  /** 当前全局 store 中的模型名（按 store.AIconfig.llm.type） */
  const getCurrentModelFromStore = (): string => {
    const llmConfig = store.AIconfig.llm
    switch (llmConfig.type) {
      case 'ollama':
        return llmConfig.ollama.model || ''
      case 'lmstudio':
        return llmConfig.lmstudio?.model || ''
      case 'openai':
        return llmConfig.openai.model || ''
      case 'deepseek':
        return deepSeekModel(llmConfig)
      case 'anthropic':
        return llmConfig.anthropic.model
      case 'google':
        return llmConfig.google.model
      case 'azure':
        return llmConfig.azure.deployment || ''
      case 'custom':
        return llmConfig.custom.model || ''
      default:
        return ''
    }
  }

  // ---------------- 连接检测 / 刷新 ----------------

  const onModelTypeChange = async () => {
    const chat = getCurrentChat()
    chat.config.model = getDefaultModel(chat.config.llmType, chat.config.customSourceIndex)
    chat.online = false
    saveChats()
  }

  /** 应用聊天绑定的自定义来源到扁平 custom（home 多自定义来源路由/测试用）；返回快照供恢复 */
  const applyChatCustomConfig = (config: any) => {
    if (config.llmType !== 'custom') return null
    const c = store.AIconfig.llm.custom
    const snap = {
      activeIndex: c.activeIndex,
      name: c.name, api_url: c.api_url, api_key: c.api_key, apiKeyRef: c.apiKeyRef,
      model: c.model, embed_model: c.embed_model,
      available_models: Array.isArray(c.available_models) ? [...c.available_models] : [],
    }
    store.applyCustomSourceIndex(config.customSourceIndex)
    return snap
  }
  const restoreChatCustomConfig = (snap: any) => {
    if (!snap) return
    const c = store.AIconfig.llm.custom
    c.activeIndex = snap.activeIndex
    c.name = snap.name; c.api_url = snap.api_url; c.api_key = snap.api_key; c.apiKeyRef = snap.apiKeyRef
    c.model = snap.model; c.embed_model = snap.embed_model
    c.available_models = snap.available_models
  }
  /** 把拉取到的自定义来源模型列表写回 sources[idx]（home 下拉显示最新模型用） */
  const syncCustomModelsToSource = (config: any) => {
    if (config.llmType !== 'custom') return
    const c = store.AIconfig.llm.custom
    const src = Array.isArray(c.sources) ? c.sources[c.activeIndex] : undefined
    if (src && Array.isArray(c.available_models)) src.available_models = [...c.available_models]
  }

  const checkCurrentModelConnection = async () => {
    const chat = getCurrentChat()
    const config = chat.config
    if (!config.model) {
      chat.online = false
      return
    }
    // 用类型覆盖探测（不修改全局 llm.type），避免并发保存把临时类型写进存档
    const customSnap = applyChatCustomConfig(config)
    try {
      await store.getAIconfig(config.llmType)
      chat.online = store.AIconfig.llm.online
      syncCustomModelsToSource(config)
      saveChats()
    } catch (error) {
      console.error('检查连接失败:', error)
      chat.online = false
    } finally {
      restoreChatCustomConfig(customSnap)
    }
  }

  const testCurrentModelConnection = async () => {
    const chat = getCurrentChat()
    const config = chat.config
    if (!config.model) {
      setConnectionTestStatus(store.locales == 'zh' ? '请先选择模型' : 'Please select a model', false)
      return
    }
    setConnectionTestStatus(store.locales == 'zh' ? '正在测试连接...' : 'Testing connection...', true)
    connectionTestIcon.value = 'fa fa-refresh fa-spin'
    connectionTestClass.value = 'step-testing'
    const customSnap = applyChatCustomConfig(config)
    try {
      await store.getAIconfig(config.llmType)
      const isOnline = store.AIconfig.llm.online
      chat.online = isOnline
      syncCustomModelsToSource(config)
      saveChats()
      if (isOnline) {
        setConnectionTestStatus(
          store.locales == 'zh' ? `模型 ${config.model} 连接成功！` : `Model ${config.model} connected successfully!`,
          true,
        )
      } else {
        setConnectionTestStatus(
          store.locales == 'zh' ? `模型 ${config.model} 连接失败，请检查配置。` : `Model ${config.model} connection failed, please check the configuration.`,
          false,
        )
      }
    } catch (error: any) {
      chat.online = false
      setConnectionTestStatus(
        store.locales == 'zh' ? '连接测试失败: ' + error.message : 'Connection test failed: ' + error.message,
        false,
      )
    } finally {
      restoreChatCustomConfig(customSnap)
    }
  }

  const refreshModels = async () => {
    const chat = getCurrentChat()
    const config = chat.config
    const customSnap = applyChatCustomConfig(config)
    try {
      await store.getAIconfig(config.llmType)
      chat.online = store.AIconfig.llm.online
      syncCustomModelsToSource(config)
      saveChats()
    } catch (error) {
      console.error('刷新模型失败:', error)
    } finally {
      restoreChatCustomConfig(customSnap)
    }
  }

  return {
    connectionTestStatus,
    connectionTestIcon,
    connectionTestClass,
    connectionTestTimeout,
    setConnectionTestStatus,
    updateStoreModelConfig,
    restoreStoreModelConfig,
    getCurrentModelFromStore,
    onModelTypeChange,
    checkCurrentModelConnection,
    testCurrentModelConnection,
    refreshModels,
  }
}
