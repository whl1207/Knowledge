import { defineStore } from "pinia"
import {nextTick} from "vue"
export const usestore=defineStore('data',{
    //创建state
    state:()=>({
        app:{
            appPath:"",
            environment:"web",//环境
            storePath:"",//仓库位置
            sharePath:"",//共享位置
            files:[] as any,//打开的文件
            fileIndex:-1,
            //通知
            notification:"",
            //视图
            domainView:["文件"] as any[],
            objectView:["浏览"] as any[],
            browser:false,
            miniView:[] as any[],
            //工具
            tool:[] as any[],
            showNav:true,
            navView:"file",
            navWidth:300,
            //视图设置
            viewSet:{
                presentation:{
                    width:'100%',
                    height:'100%'
                }
            } as any,
            //打开文件的行为
            clickToOpen:"智能操作",
            //界面
            UI:{
                scale:1,//缩放
                theme:"灰色",
                fontsize:15,
                backgroundColor:'rgb(30,30,30)',  /**背景颜色**/
                menuColor:'#303030',/**菜单颜色**/
                menuActiveColor:'#4c4c4c',/**菜单激活颜色**/
                fontColor:'#ffffff',/**字体颜色**/
                fontActiveColor:'#ffff00',/**字体激活颜色**/
                borderColor:'#555555',/**边框颜色**/
                isFull:false,/**是否全屏**/
                isMenu:true,/**显示标题栏**/
                layout:'column',/**横向布局**/
                extension:true,/**显示后缀**/
            },
            //领域数据路径
            path:"",
            //领域数据
            data:{
                nodes:[],
                edges:[],
                combos:[],
            } as any,
            //默认展开的节点
            defaultExpandedKeys:[] as any,
            //代码样式
            highlightCSS:"github-dark.css",
            //搜索关键词
            keyword:"",

            //对话框类型
            dialog:"",

            //服务器设置
            server:{
                state:false,//是否打开了服务器
                username: "管理员",//网络中的名称
                password:"",//数据修改密码
                ip:"",//本机ip，暂时无用
                mac:"",//本机mac，暂时无用
            },
            
            //网络配置
            network:[] as any,
            networkIndex:-1,
            //日志
            logs:[] as any[],
            
        },
        web:"",
        catalogue:[] as any,//目录结构
        currMp3Buffer: null, //Buffer.alloc(0), //tts
        currMp3Url: "", //ttsurl
    }), 
    //计算
    getters:{},
    //方法
    actions:{
        init(){
            //判断软件处于什么环境
            const flag = window && window.process && window.process.versions && window.process.versions['electron']
            if(flag!=undefined){
                //为electron环境时
                this.app.environment="electron:"+flag
                //记录软件的安装位置
                let that=this
                let ipcRenderer = require('electron').ipcRenderer
                ipcRenderer.send('getAppPath');
                ipcRenderer.on('getAppPathReply', (event:any, data:any) => {
                    that.app.appPath=data;
                });
                //读取共享文件夹位置
                const fs = require('fs')
                const path = require('path')
                const configPath = path.join(that.app.appPath, './config.json');
                const configFile = fs.readFileSync(configPath, 'utf8');
                const config = JSON.parse(configFile);
                that.app.sharePath=config.sharePath;
                this.app.navView="file"
            }else{
                //为网络环境时
                this.app.navView="cloud"
            }
            //判断软件是否已经初始化
            if(localStorage.getItem('app')!=null){
                let temp=JSON.parse(localStorage.getItem('app')||'{}')
                this.app={...this.app,...temp}
            }else{
                localStorage.setItem('app',JSON.stringify(this.app))
            }
        },
        //储存当前设置
        saveApp(){
            localStorage.setItem('app',JSON.stringify(this.app))
        },
        //选择储存库
        setStorePath() {
            let that=this
            let ipcRenderer = require('electron').ipcRenderer
            ipcRenderer.send('openStorePath', 'openDirectory');
            ipcRenderer.on('selectedStorePath', function (e:any, result:any) {
              if(result.canceled==false){
                //设置储存库路径
                that.app.storePath = result.filePaths[0]+"\\"
                //设置领域路径
                that.app.path = result.filePaths[0]+"\\"
                //清空标签
                that.app.files=[]
                //设置配置文件
                const fs = require('fs')
                const path = require('path')
                // 读取配置文件
                const configPath = path.join(that.app.appPath, './config.json')
                const configData = fs.readFileSync(configPath, 'utf-8')
                const config = JSON.parse(configData)
                //更新配置文件
                config.storePath = that.app.storePath
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
                that.saveApp()
              }
            })
        },
        //选择共享库
        setSharePath() {
            let that=this
            let ipcRenderer = require('electron').ipcRenderer
            ipcRenderer.send('openSharePath', 'openDirectory');
            ipcRenderer.on('selectedSharePath', function (e:any, result:any) {
              if(result.canceled==false){
                //设置vue中储存的共享库位置
                that.app.sharePath = result.filePaths[0]+"\\"
                //设置配置文件
                const fs = require('fs')
                const path = require('path')
                // 读取配置文件
                const configPath = path.join(that.app.appPath, './config.json')
                const configData = fs.readFileSync(configPath, 'utf-8')
                const config = JSON.parse(configData)
                //更新配置文件
                config.sharePath = that.app.sharePath
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
                that.saveApp()
              }
            })
        },
        //打开文件
        openFile() {
            let ipcRenderer = require('electron').ipcRenderer
            const path = ipcRenderer.sendSync('openFile',[])
            console.log(path)
            const data = {
                fullPath:path,//文件夹绝对路径
                parentPath:path.substring(0,path.lastIndexOf("\\")),//父级文件夹绝对路径
                name:path.substring(path.lastIndexOf("\\")+1,path.lastIndexOf(".")==-1?path.length:path.lastIndexOf(".")),//文件名称（不包含后缀）
                fullName:path.substring(path.lastIndexOf("\\")+1,path.length),//文件名称（包含后缀）
                type:path.substring(path.lastIndexOf(".")+1)==path?'':path.substring(path.lastIndexOf(".")+1),//文件类型
            }
            const fs = require("fs")
            let content=fs.readFileSync(path,'utf8')
            let File = {...data,content}
            this.addTab(File)
        },
        //向上一个层级
        pathBack(){
            if(this.app.environment!="web"){
                if(this.app.path==this.app.storePath) return
                if(this.app.path.substring(0,this.app.path.lastIndexOf("\\")).indexOf("\\")==-1) return
                this.app.path=this.app.path.substring(0,this.app.path.lastIndexOf("\\"))
            }else{
                if(this.app.path.substring(0,this.app.path.lastIndexOf("\\")).indexOf("\\")==-1){
                    this.app.path=""
                }else{
                    this.app.path=this.app.path.substring(0,this.app.path.lastIndexOf("\\"))
                }
            }
        },
        //打开标签
        addTab(data:any){
            //默认内部打开的文件
            const availableType=[
                ".md",
                ".pdf",
                "",
                ".html",
                ".js",
                ".css",
                ".ts",
                ".py",
                ".json",
                ".jpg",
                ".jpeg",
                ".png",
                ".webp",
                ".mp4",
                ".wmv",
                ".avi",
                ".mp3",
                ".m4a",
                ".wb"
            ]
            //不是文件夹、在可用格式内部、不是云端文件，使用默认应用打开
            if((!data.isFolder)&&(!(availableType.indexOf(data.type)>-1))&&(data.cloud==false||data.cloud==undefined)){
                //本地打开
                let shell=null as any
                let fs =null as any
                if(this.app.environment!="web"){
                    shell = require("electron").shell
                    fs=require("fs")
                }
                let path = data.parentPath+'\\'+data.fullName
                if(path!=""){
                    fs.exists(path, (exists:any) => {
                        if (exists) shell.openPath(path)
                    })
                }
                return false
            }
            //判断文件是否已打开
            let exists=false
            for(let i=0;i<this.app.files.length;i++){
                if(this.app.files[i].fullPath==data.fullPath){
                    exists=true
                    this.app.fileIndex=i
                    //切换领域路径
                    if(this.app.files[this.app.fileIndex].isFolder){
                        this.app.path=this.app.files[this.app.fileIndex].fullPath
                    }else{
                        this.app.path=this.app.files[this.app.fileIndex].parentPath
                    }
                    //变更为推荐视图
                    if(data.attributes['推荐领域视图']!=undefined){
                        this.app.domainView=[data.attributes['推荐领域视图']]
                    }
                    if(data.attributes['推荐对象视图']!=undefined){
                        this.app.objectView=[data.attributes['推荐对象视图']]
                    }
                }
            }
            //如果文件没有打开
            if(exists!=true){
                if(this.app.clickToOpen=="智能操作"){
                    //文件访问上级，文件夹访问本级
                    this.app.files.unshift(data)
                    this.app.fileIndex=0
                    if(this.app.environment!="web"){
                        if(this.app.files[this.app.fileIndex].isFolder){
                            this.app.path=this.app.files[this.app.fileIndex].fullPath
                        }else{
                            this.app.path=this.app.files[this.app.fileIndex].parentPath
                        } 
                    }
                }else if(this.app.clickToOpen=="上级，无分页"){
                    //打开图谱上级
                    this.app.path=data.parentPath
                }else if(this.app.clickToOpen=="本级，无分页"){
                    //打开图谱本级
                    this.app.path=data.fullPath
                }else if(this.app.clickToOpen=="上级，有分页"){
                    //打开图谱上级，且添加分页
                    this.app.files.unshift(data)
                    this.app.fileIndex=0
                    this.app.path=this.app.files[this.app.fileIndex].parentPath
                }else if(this.app.clickToOpen=="本级，有分页"){
                    //打开图谱本级，且添加分页
                    this.app.files.unshift(data)
                    this.app.fileIndex=0
                    this.app.path=this.app.files[this.app.fileIndex].fullPath
                }
                if(data.attributes['推荐领域视图']!=undefined){
                    this.app.domainView=[data.attributes['推荐领域视图']]
                }
                if(data.attributes['推荐对象视图']!=undefined){
                    this.app.objectView=[data.attributes['推荐对象视图']]
                }
                this.saveApp()
                return true
            }else{
                return false
            }
        },
        getCloudData(path:string,deep:number,showSelf:number){
            let that = this
            return new Promise(function(resolve, reject) {
              var xhr = new XMLHttpRequest();
        
              xhr.onreadystatechange = function() {
                if (xhr.readyState === 4) {
                  if (xhr.status >= 200 && xhr.status < 300 || xhr.status == 304) {
                    xhr.onload = function () {
                      if (xhr.responseText != "") {
                        let content=xhr.responseText //文件内容
                        resolve(content) // 使用resolve将获取到的数据传递给后续操作
                      }
                    }
                  } else {
                    reject(xhr.statusText) // 请求失败，使用reject传递错误信息
                  }
                }
              }
              // 发送异步请求
              const address = "http://" + that.app.network[that.app.networkIndex].ip + ":" + that.app.network[that.app.networkIndex].port+"/?type=domain&parentPath="+path+"&deep="+deep+"&showSelf="+showSelf
              xhr.open('get', address)
              xhr.timeout = 500
              xhr.send()
            })
        },
        async resize(){
            await nextTick()
            if(document.createEvent) {
              var event = document.createEvent("HTMLEvents");
              event.initEvent("resize", true, true);
              window.dispatchEvent(event);
            }
        },
        changeTheme(data:string){
            if(data=="dark"){
                this.app.UI.theme="深色"
                this.app.UI.backgroundColor="#0D1117"
                this.app.UI.borderColor="#30363D"
                this.app.UI.menuColor="#010409"
                this.app.UI.menuActiveColor="#24272E"
                this.app.UI.fontColor="#ffffff"
                this.app.UI.fontActiveColor="#CCA700"
            }else if(data=="grey"){
                this.app.UI.theme="灰色"
                this.app.UI.backgroundColor="#1e1e1e"
                this.app.UI.borderColor="#444444"
                this.app.UI.menuColor="#303030"
                this.app.UI.menuActiveColor="#4c4c4c"
                this.app.UI.fontColor="#ffffff"
                this.app.UI.fontActiveColor="#ffff00"
            }else if(data=="tint"){
                this.app.UI.theme="米色"
                this.app.UI.backgroundColor="#F9E9CD"
                this.app.UI.borderColor="#555555"
                this.app.UI.menuColor="#F9E9CD"
                this.app.UI.menuActiveColor="#F3FFB6"
                this.app.UI.fontColor="#000000"
                this.app.UI.fontActiveColor="#057748"
            }else if(data=="white"){
                this.app.UI.theme="白色"
                this.app.UI.backgroundColor="#ffffff"
                this.app.UI.borderColor="#888888"
                this.app.UI.menuColor="#dddddd"
                this.app.UI.menuActiveColor="#cccccc"
                this.app.UI.fontColor="#111111"
                this.app.UI.fontActiveColor="#990000"
            }else if(data=="blue"){
                this.app.UI.theme="蓝色"
                this.app.UI.backgroundColor="#22234d"
                this.app.UI.borderColor="#ffffff44"
                this.app.UI.menuColor="#27284c"
                this.app.UI.menuActiveColor="#1d1f41"
                this.app.UI.fontColor="#ffffff"
                this.app.UI.fontActiveColor="#f1c833"
            }else if(data=="red"){
                this.app.UI.theme="红色"
                this.app.UI.backgroundColor="#4E0104"
                this.app.UI.borderColor="#FFFFFF88"
                this.app.UI.menuColor="#AE1F25"
                this.app.UI.menuActiveColor="#DE2A18"
                this.app.UI.fontColor="#FFFFFF"
                this.app.UI.fontActiveColor="#DF8B45"
            }
            document.documentElement.style.setProperty("--backgroundColor",this.app.UI.backgroundColor);
            document.documentElement.style.setProperty("--menuColor",this.app.UI.menuColor);
            document.documentElement.style.setProperty("--menuActiveColor",this.app.UI.menuActiveColor);
            document.documentElement.style.setProperty("--fontColor",this.app.UI.fontColor);
            document.documentElement.style.setProperty("--fontActiveColor",this.app.UI.fontActiveColor);
            document.documentElement.style.setProperty("--borderColor",this.app.UI.borderColor);
        },
        //格式化时间
        formatDate(value:any,offest:any) {
            let date = new Date()
            if(value!=undefined){
                let aDate = value.split("-")
                date = new Date(aDate[1] + '-' + aDate[2] + '-' + aDate[0])
            }
            if(offest!=undefined) date.setDate(date.getDate()+offest)
            let year = date.getFullYear()
            let month = date.getMonth() + 1
            let day = date.getDate()
            let monthstring=""
            let daystring=""
            if (month < 10) {
                monthstring = "0" + month
            }else{
                monthstring = "" + month
            }
            if (day < 10) {
                daystring = "0" + day
            }else{
                daystring = "" + day
            }
            let str = year + "-" + monthstring + "-" + daystring
            return str
        },
        StampToDate(date?:any) {
            if(date==undefined) date = new Date()
            const year = date.getFullYear();
            const month = ('0' + (date.getMonth() + 1)).slice(-2);
            const day = ('0' + date.getDate()).slice(-2);
            const hour = ('0' + date.getHours()).slice(-2);
            const min = ('0' + date.getMinutes()).slice(-2);
            const sec = ('0' + date.getSeconds()).slice(-2);
            return `${year}-${month}-${day} ${hour}:${min}:${sec}`;
        },
        formatTimeStamp(value:any) {
            let date = new Date()
            if(value==undefined) date = new Date(value)
            let y = date.getFullYear()
            let m = date.getMonth() + 1
            let d = date.getDate()
            let H = date.getHours()
            let M = date.getMinutes()
            let S = date.getSeconds()
            let ms=m < 10?"0" + m:m.toString()
            let ds=d < 10?"0" + d:d.toString()
            let Hs=H<10?"0"+H:H.toString()
            let Ms=M<10?"0"+M:M.toString()
            let Ss=S<10?"0"+S:S.toString()
            let str = y + "-" + ms + "-" + ds +" "+Hs+":"+Ms+":"+Ss
            return str
        },
        //图标
        icon: function (type:string){
            let c="fa fa-th"
            switch(type)
            {
            case "":c="fa fa-folder";
            break;
            case ".md":c="fa fa-file-text-o";
            break;
            case ".txt":c="fa fa-file-text-o";
            break;
            case ".ini":c="fa fa-file-text-o";
            break;
            case ".pptx":c="fa fa-file-powerpoint-o";
            break;
            case ".ppt":c="fa fa-file-powerpoint-o";
            break;
            case ".doc":c="fa fa-file-word-o";
            break;
            case ".docx":c="fa fa-file-word-o";
            break;
            case ".xls":c="fa fa-file-excel-o";
            break;
            case ".xlsx":c="fa fa-file-excel-o";
            break;
            case ".zip":c="fa fa-file-archive-o";
            break;
            case ".rar":c="fa fa-file-archive-o";
            break;
            case ".png":c="fa fa-file-image-o ";
            break;
            case ".jpg":c="fa fa-file-image-o ";
            break;
            case ".jpeg":c="fa fa-file-image-o ";
            break;
            case ".webp":c="fa fa-file-image-o ";
            break;
            case ".pdf":c="fa fa-file-pdf-o";
            break;
            case ".html":c="fa fa-file-code-o";
            break;
            case ".js":c="fa fa-file-code-o";
            break;
            case ".css":c="fa fa-file-code-o";
            break;
            case ".json":c="fa fa-file-code-o";
            break;
            case ".ts":c="fa fa-file-code-o";
            break;
            case ".mp4":c="fa fa-file-video-o";
            break;
            case ".wmv":c="fa fa-file-video-o";
            break;
            case ".avi":c="fa fa-file-video-o";
            break;
            case "flv":c="fa fa-file-video-o";
            break;
            case ".mp3":c="fa fa-file-audio-o";
            break;
            case ".m4a":c="fa fa-file-audio-o";
            break;
            case ".wb":c="fa fa-file-o";
            break;
            case ".exe":c="fa fa-windows"
            default:
            c="fa fa-th";
            }
            return c
        },
    }
})