import { createApp } from 'vue'
import App from './App.vue'
import {createPinia} from 'pinia'

//导入element-ui
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

const app=createApp(App);

//配置插件
app.use(ElementPlus,{
  locale: zhCn,
});
app.use(createPinia());
//初始化系统
app.mount('#app');