// main.js
// 控制应用生命周期和创建原生浏览器窗口的模组
const { app, BrowserWindow,Menu,Tray, dialog ,ipcMain} = require('electron')
const path = require('path')

/**开发环境变量
 * 设置为development时使用vite可进行热更新
 * 打包时需要设置为其他*/

const NODE_ENV = "development"

let mainWindow = null
function createWindow (mainWindow) {
  // 创建浏览器窗口
  
}
// 这段程序将会在 Electron 结束初始化
// 和创建浏览器窗口的时候调用
// 部分 API 在 ready 事件触发后才能使用。

app.whenReady().then(() => {
  //创建窗体
  mainWindow = new BrowserWindow({
    width: 1300,//窗口宽度
    height: 830,//窗口高度
    minWidth: 860,
    minHeight: 352,
    show: false,
    //alwaysOnTop:true,
    titleBarStyle: 'hidden',//隐藏标题栏
    //icon: path.join(__dirname,'./public/icons/icon.png'),//图标
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,  //是否启用Node integration. 默认值为 false
      contextIsolation: false, //是否在独立 JavaScript 环境中运行 Electron API和指定的preload 脚本. 默认为 true。
      webSecurity: false, //跨域请求
      spellcheck: false, //纠错
      webviewTag: true //webview标签
    }
  })
  // 初始化后再显示窗体
  mainWindow.on('ready-to-show', function () {
    mainWindow.show()
  })
  // 外部打开链接
  mainWindow.webContents.setWindowOpenHandler((details) => {
    require('electron').shell.openExternal(details.url);
  })
  // 清空菜单栏
  var menuTemplate=[];
  var menuBuilder=Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menuBuilder);

  // 根据环境加载主页
  mainWindow.loadURL(
    NODE_ENV === 'development'
      ? 'http://localhost:3000'
      :`file://${path.join(__dirname, '../dist/index.html')}`
  );
  // 打开开发工具
  if(NODE_ENV === 'development'){
    mainWindow.webContents.openDevTools({ mode: "undocked", activate: true });
  }
  
  //右键菜单
  app.on('activate', function () {
    // 通常在 macOS 上，当点击 dock 中的应用程序图标时，如果没有其他
    // 打开的窗口，那么程序会重新创建一个窗口。
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  // 设置系统托盘
  /**
  trayIconDir = path.join(__dirname, '../public/');
  trayIcon    = path.join(trayIconDir, 'icon.ico')
  appTray = new Tray(trayIcon);
  var trayMenuTemplate = [
    {
        label: '退出',
        click: function () {
        app.quit();
    }
  }];
  const trayMenu = Menu.buildFromTemplate(trayMenuTemplate);
  appTray.setToolTip('河图');
  appTray.setContextMenu(trayMenu);
  */
  //创建网络通信服务
})

// 除了 macOS 外，当所有窗口都被关闭的时候退出程序。 因此，通常对程序和它们在
// 任务栏上的图标来说，应当保持活跃状态，直到用户使用 Cmd + Q 退出。
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})
// 在这个文件中，你可以包含应用程序剩余的所有部分的代码，
// 也可以拆分成几个文件，然后用 require 导入。

//选择储存库位置
ipcMain.on('openStorePath', function (event, p) {
  dialog.showOpenDialog({
      properties: [p],
      title: '请选择位置，注意不要选择根目录',
      buttonLabel: '选择'
  }).then(result => {
      event.sender.send('selectedStorePath', result)
  })
})
//选择共享库位置
ipcMain.on('openSharePath', function (event, p) {
  dialog.showOpenDialog({
      properties: [p],
      title: '请选择位置，注意不要选择根目录',
      buttonLabel: '选择'
  }).then(result => {
      event.sender.send('selectedSharePath', result)
  })
})
//打开文件
ipcMain.on('openFile',(event,type)=>{
  dialog.showOpenDialog(mainWindow, {
    title:'打开文件',
    filters:[{
      name:type,
      extensions:type,
    }],
    buttonLabel:'打开'
  }).then(result => {
    if(!result.canceled && result.filePaths.length > 0){
      event.returnValue = result.filePaths[0]
    }else{
      event.returnValue = ""
    }
  }).catch(err => {
    console.log(err)
  })
})
//选择储存库位置
ipcMain.on('openTreePath', function (event, p) {
  dialog.showOpenDialog({
      properties: [p],
      title: '请选择位置，并读取树形关系',
      buttonLabel: '选择'
  }).then(result => {
      event.sender.send('selectedTreePath', result)
  })
})
// 窗口全屏
ipcMain.on('fullWindow', () => {
  mainWindow.setFullScreen(!mainWindow.isFullScreen())
})
// 窗口置顶
ipcMain.on('topWindow', () => {
  mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop())
})
// 窗口最小
ipcMain.on('minWindow', () => {
  mainWindow.minimize();
})
// 退出应用
ipcMain.on('closeWindow', () => {
  app.quit()
})

//开发者选项
ipcMain.on('dev', () => {
  if (mainWindow.webContents.isDevToolsOpened()) {
    mainWindow.webContents.closeDevTools();
  } else {
    mainWindow.webContents.openDevTools({ mode: "undocked", activate: true });
  }
})
//获取程序位置
ipcMain.on('getAppPath', (event) => {
  let appPath=""
  //判断是否被打包了
  if(app.isPackaged){
    appPath=path.join(app.getAppPath(), "../..")
  }else{
    appPath=app.getAppPath()
  }
  event.sender.send('getAppPathReply', appPath)
})
//服务器函数
const server = require("./server")(mainWindow)
//打开服务器
ipcMain.on('OpenServer', () => {
  let appPath=""
  //判断是否被打包了
  if(app.isPackaged){
    appPath=path.join(app.getAppPath(), "../..")
  }else{
    appPath=app.getAppPath()
  }
  server.open(mainWindow,appPath)
})
//关闭服务器
ipcMain.on('CloseServer', () => {
  server.close()
})
