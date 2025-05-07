import { createApp } from 'vue'
import App from './App.vue'
import {createPinia} from 'pinia'
import { ElTree } from 'element-plus';
import 'element-plus/theme-chalk/index.css';
import './style.css'

//import './demos/ipc'
// If you want use Node.js, the`nodeIntegration` needs to be enabled in the Main process.
// import './demos/node'

createApp(App)
  .use(createPinia())
  .component(ElTree.name!, ElTree)
  .mount('#app')
  .$nextTick(() => {
    postMessage({ payload: 'removeLoading' }, '*')
  })
