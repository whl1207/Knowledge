import { app, BrowserWindow, shell, ipcMain, dialog,globalShortcut,Menu } from 'electron'
import { release } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fs from 'fs'
import * as path from 'path'
import yaml from 'js-yaml'
import mammoth from "mammoth"
import TurndownService from 'turndown'
import xlsx from 'xlsx'
import * as PDFJS from 'pdfjs-dist'
import http from 'http'
import WebSocket from 'ws';

globalThis.__filename = fileURLToPath(import.meta.url)
globalThis.__dirname = dirname(__filename)

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs    > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.DIST_ELECTRON = join(__dirname, '..')
process.env.DIST = join(process.env.DIST_ELECTRON, '../dist')
process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? join(process.env.DIST_ELECTRON, '../public')
  : process.env.DIST

// Disable GPU Acceleration for Windows 7
if (release().startsWith('6.1')) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const boundsFilePath = path.join(app.getPath('userData'), 'window-bounds.json');
// Remove electron security warnings
// This warning only shows in development mode
// Read more on https://www.electronjs.org/docs/latest/tutorial/security
// process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

let win: BrowserWindow | null = null
// Here, you can also use other preload
const preload = join(__dirname, '../preload/index.mjs')
const url = process.env.VITE_DEV_SERVER_URL
const indexHtml = join(process.env.DIST, 'index.html')

async function createWindow() {
  win = new BrowserWindow({
    title: 'AI-KM',
    width: 600, // 设置窗口的初始宽度
    height: 600, // 设置窗口的初始高度
    minWidth: 550,
    minHeight: 350,
    //transparent: true, // 设置窗口透明
    icon: join(process.env.VITE_PUBLIC, 'favicon.ico'),
    titleBarStyle: 'hidden',//隐藏标题栏
    webPreferences: {
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // nodeIntegration: true,

      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      // contextIsolation: false,
      webSecurity: false
    },
  })
  if (process.platform === 'linux') {
    win.setMenuBarVisibility(false)
    // 或者完全移除菜单
    Menu.setApplicationMenu(null)
  }
  if (fs.existsSync(boundsFilePath)) {
    const bounds = JSON.parse(fs.readFileSync(boundsFilePath, { encoding: 'utf8' }));
    win.setBounds(bounds);
  }
  globalShortcut.register('CommandOrControl+=', () => {
    // 获取当前页面的缩放因子
    const zoomFactor = win.webContents.zoomFactor;
    // 增加缩放因子 0.1
    win.webContents.zoomFactor = zoomFactor + 0.1;
  });
  if (process.env.VITE_DEV_SERVER_URL) { // electron-vite-vue#298
    win.loadURL(url)
    // Open devTool if the app is not packaged
    
    win.webContents.openDevTools({mode:'undocked'})
    /**let devtools = new BrowserWindow()
    win.webContents.setDevToolsWebContents(
      devtools.webContents
    );**/
  } else {
    win.loadFile(indexHtml)
  }
  win.on('resize', () => {
    fs.writeFileSync(boundsFilePath, JSON.stringify(win.getBounds()));
  });

  win.on('move', () => {
    fs.writeFileSync(boundsFilePath, JSON.stringify(win.getBounds()));
  });
  // Test actively push message to the Electron-Renderer
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault(); // 阻止在应用内导航
    // 在外部浏览器中打开链接
    shell.openExternal(url);
  })
  
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  win = null
  //wss.clients.forEach(client => client.close());
  if (process.platform !== 'darwin') app.quit()
})

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})
// New window example arg: new windows url
ipcMain.handle('open-win', (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${url}#${arg}`)
  } else {
    childWindow.loadFile(indexHtml, { hash: arg })
  }
})

//使用webscoket传输数据
let wss;
function createWebscoket(){
  // 创建WebSocket服务器
  wss = new WebSocket.Server({ port: 8080 });

  wss.on('connection', function connection(ws) {
    console.log('WebSocket连接已建立');

    // 当收到消息时的处理逻辑
    ws.on('message', function incoming(message) {
      console.log('收到消息: %s', message);
    });

    // 定时向客户端推送数据
    setInterval(() => {
      ws.send(JSON.stringify({ data: '需要推送的数据' }));
    }, 1000); // 每秒推送一次数据
  });
}
// 在渲染进程中调用该函数来获取文件树
ipcMain.handle('createWebscoket', (event) => {
  createWebscoket()
  return "开启成功";
})

//读取文件树
function getDirectoryTree(directoryPath) {
  const absolutePath = path.resolve(directoryPath);
  const stats = fs.statSync(directoryPath);
  if (stats.isDirectory()) {
    const files = fs.readdirSync(directoryPath);
    const tree = {
      label: path.basename(directoryPath),
      type: 'folder',
      path: absolutePath,
      children: files.map(file => getDirectoryTree(path.join(directoryPath, file))),
      extension: 'folder'
    }
    return tree;
  } else {
    return {
      label: path.basename(directoryPath),
      type: 'file',
      path: absolutePath,
      extension: path.extname(directoryPath)
    };
  }
}

// 在渲染进程中调用该函数来获取文件树
ipcMain.handle('getDirectoryTree', (event, folderPath) => {
  if (folderPath) {
    const tree = [getDirectoryTree(folderPath)];
    
  //监听文件变化
    fs.watchFile(folderPath, (curr:any, prev:any) => {
      //发送消息
      console.log("文件变化")
    })
    return tree;
  }
})
//读取文件树
function getFiles(folderPath, depth, fileList) {
  fileList = fileList || [];
  const files = fs.readdirSync(folderPath);
  depth--;

  files.forEach(file => {
    const filePath = path.join(folderPath, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory() && depth > 0) {
      getFiles(filePath, depth, fileList);
    } else {
      const fileExtension = path.extname(filePath);
      let fileData = {
        label: path.basename(filePath),
        type: 'folder',
        path: filePath,
        extension: stats.isDirectory()?'folder':fileExtension,
        attributes:{}
      }
      fileData.attributes = getConfig(filePath)
      fileList.push(fileData);
    }
  });
  return fileList;
}
//读取文件关系
function getFilesRelation(folderPath, depth, parentIndex) {
  let fileList = []
  const files = fs.readdirSync(folderPath)
  depth--
  //console.log("deep:"+depth)
  let relationList = []
  let currentIndex=(parentIndex==undefined)?0:(parentIndex+1)
  files.forEach(file => {
    const filePath = path.join(folderPath, file)
    const stats = fs.statSync(filePath)

    if (stats.isDirectory() && depth > 0) {
      const directoryData = {
        id: currentIndex,
        label: file,
        type: 'folder',
        path: filePath,
        extension: 'folder',
        attributes: {}
      }
      fileList.push(directoryData)
      if (parentIndex !== undefined) {
        relationList.push({ source: parentIndex, target: currentIndex })
      }
      const { fileList: childList, relationList: childRelationList } = getFilesRelation(filePath, depth, currentIndex)
      currentIndex=currentIndex+childList.length
      //console.log(currentIndex,childRelationList.length)
      fileList = fileList.concat(childList)
      relationList = relationList.concat(childRelationList)
    } else if (depth >= 0) {
      const fileExtension = stats.isDirectory() ? 'folder' : path.extname(filePath)
      const fileData = {
        id: currentIndex,
        label: file,
        type: 'file',
        path: filePath,
        extension: fileExtension,
        attributes: {}
      }
      fileData.attributes = getConfig(filePath)
      fileList.push(fileData)
      if (parentIndex !== undefined) {
        relationList.push({ source: parentIndex, target: currentIndex })
      }
    }
    currentIndex++
  })
  return { fileList, relationList }
}
//读取配置文件
function getConfig(fullPath){
  try {
      let isFolder=fs.statSync(fullPath).isDirectory()
      fullPath = isFolder?(fullPath+"\\.readme.md"):(fullPath)
      if(path.extname(fullPath)!='.md') return {}
      let isFile = fs.existsSync(fullPath) //判断文件是否存在
      if(isFile){
          const fileContent = fs.readFileSync(fullPath, 'utf8')
          const matches = fileContent.match(/^---\r?\n([\s\S]+?)\r?\n---/) // 如果找到匹配项，则解析YAML头
          if (matches && matches.length > 1) {
              // 提取YAML头的内容
              const yamlHeader = matches[1]
              // 解析YAML头并返回结果
              try {
                  const headerObj = yaml.load(yamlHeader)
                  return headerObj
              } catch (error) {
                  console.error('Failed to parse YAML header:', error)
                  return {}
              }
          }else{
              return {}//不存在时返回默认配置
          }
      }else{
          return {}//不存在时返回默认配置
      }
  } catch (error) {
      console.error('An error occurred while trying to load the js-yaml module:', error);
  }        
}
// 获取配置
ipcMain.handle('getConfig', (event, path) => {
  if (path) {
    return getConfig(path)
  }
})
// 在渲染进程中调用该函数来获取文件列表
ipcMain.handle('getFiles', (event, folderPath,n) => {
  if (folderPath) {
    const files = getFiles(folderPath,n,[])
    return files
  }
})
// 在渲染进程中调用该函数来获取文件关系
ipcMain.handle('getFilesRelation', (event, folderPath,n) => {
  if (folderPath) {
    const { fileList, relationList } = getFilesRelation(folderPath,n,undefined)
    return { fileList, relationList }
  }
})
// 通过对话框打开文件，并返回路径
ipcMain.handle('openFileDialog', async (event) => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile']
  });

  if (!result.canceled) {
    return result.filePaths[0];
  } else {
    return null;
  }
});

// 通过对话框打开文件夹，并返回路径
ipcMain.handle('openFolderDialog', async (event) => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory']
  });

  if (!result.canceled) {
    return result.filePaths[0];
  } else {
    return null;
  }
});
//读取PDF
async function readPdf(filePath: string){
  const loadingTask = PDFJS.getDocument(filePath);
  const pdfDocument = await loadingTask.promise;
  const pageCount = pdfDocument.numPages;
  let textContent = '';

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDocument.getPage(i);
    const content = await page.getTextContent();
    const strings = (content as {items: {str: string}[]}).items.map(item => item.str);
    textContent += strings.join(' ');
  }
  return textContent;
}
function convertToMarkdown(data) {
  let markdown = '';

  // 生成表头
  const headers = data[0];
  markdown += '| ' + headers.join(' | ') + ' |\n';

  // 生成分隔线
  markdown += '| ' + headers.map(() => '---').join(' | ') + ' |\n';

  // 生成表格内容
  for (let i = 1; i < data.length; i++) {
    markdown += '| ' + data[i].join(' | ') + ' |\n';
  }

  return markdown;
}
//创建文件
async function createFile(directoryPath: string, fileName: string): Promise<string | null> {
  try {
    // 检查目录是否存在
    if (!fs.existsSync(directoryPath)) {
      throw new Error(`目录 ${directoryPath} 不存在`);
    }

    // 拼接文件路径
    const filePath = path.join(directoryPath, fileName);

    // 检查文件是否已存在
    if (fs.existsSync(filePath)) {
      throw new Error(`文件 ${filePath} 已存在`);
    }

    // 创建空文件
    fs.writeFileSync(filePath, '');
    return filePath;
  } catch (error) {
    console.error('创建文件失败:', error);
    return null;
  }
}

// 暴露给渲染进程调用
ipcMain.handle('createFile', async (event, directoryPath: string, fileName: string) => {
  return await createFile(directoryPath, fileName);
});

//返回文件信息
function getInf(filePath) {
  try {
    // 获取文件或文件夹的状态
    const stats = fs.statSync(filePath);

    // 判断是文件还是文件夹
    const type = stats.isDirectory() ? 'folder' : 'file';

    // 获取文件名（label）
    const label = path.basename(filePath);

    // 获取文件扩展名（如果是文件夹，则返回 'folder'）
    const extension = type === 'folder' ? 'folder' : path.extname(filePath);

    return {
      type,
      label,
      extension,
    };
  } catch (error) {
    console.error(`Error getting file info for path ${filePath}:`, error);
    return null;
  }
}
ipcMain.handle('getInf', async (event, path: string) => {
  return await getInf(path);
});
//删除文件
ipcMain.handle('deleteFile', async (event, filePath) => {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
});
//判断是不是文件夹
ipcMain.handle('isDirectory', (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
});
//读取文件
ipcMain.handle('readFile', async (event, filePath) => {
  //判断类型并读取文件
  const fileExtension = path.extname(filePath);
  if(fileExtension==".md"||fileExtension==""||fileExtension==".kb"){
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      return fileContent;
    } catch (error) {
      return `Error reading file: ${error.message}`;
    }
  }else if(fileExtension==".docx"){
    try {
      const { value: html } = await mammoth.convertToHtml({ path: filePath })
      const turndownService = new TurndownService()
      const result = turndownService.turndown(html)
      return result
    } catch (err) {
      console.error(err);
      throw err; // 可以选择抛出错误，让调用方处理
    }
  }else if(fileExtension==".pdf"){
    const result = await readPdf(filePath)
    return result
  }else if(fileExtension==".xlsx"){
    const workbook = xlsx.readFile(filePath);
    // 初始化Markdown内容
    let allMarkdownContent = '';

    // 遍历所有工作表
    workbook.SheetNames.forEach(sheetName => {
      const worksheet = workbook.Sheets[sheetName]

      // 将工作表转换为JSON格式
      const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 })

      // 将JSON数据转换为Markdown
      const markdownContent = convertToMarkdown(jsonData)

      // 添加工作表名称作为标题
      allMarkdownContent += `## ${sheetName}\n\n`
      
      // 添加工作表的Markdown内容
      allMarkdownContent += markdownContent + '\n\n'
    })
    return allMarkdownContent
  }
})
//打开并读取文件
ipcMain.handle('openAndReadFile', async (event, type) => {
  const result = await dialog.showOpenDialog(win, {
    title: '打开文件',
    filters: [{
      name: type,
      extensions: type,
    }],
    buttonLabel: '打开'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0];
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      return fileContent;
    } catch (error) {
      return `Error reading file: ${error.message}`;
    }
  } else {
    return "";
  }
});
//保存文件
ipcMain.handle('saveFile', async (event, filePath, fileContent) => {
  try {
    fs.writeFileSync(filePath, fileContent);
    return true; // 保存成功
  } catch (error) {
    console.error(error);
    return false; // 保存失败
  }
});
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
ipcMain.on('closeWindow', () => {
  app.quit()
})

// 通过对话框打开文件夹，并返回路径
ipcMain.handle('openByApp', async (event,path) => {
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    if(path!=""){
      fs.exists(path, (exists:any) => {
        if (exists) shell.openPath(path)
      })
    }
  }
});
//开发者选项
ipcMain.on('dev', () => {
  if (win.webContents.isDevToolsOpened()) {
    win.webContents.closeDevTools();
  } else {
    win.webContents.openDevTools({ mode: "undocked", activate: true });
  }
})
//打开文件
ipcMain.handle('openFile',async(event)=>{
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile']
  })

  if (!result.canceled && result.filePaths.length > 0) {
    const filePath = result.filePaths[0]
    const content = fs.readFileSync(filePath, 'utf-8')
    return { content, filePath }
  }

  return { content: null, filePath: null }
})

ipcMain.handle('showDialog', async (event, options) => {
  const result = await dialog.showMessageBox(options);
  return result;
});


//服务器操作
let server;

// 创建 HTTP 服务器
function startServer() {
  if(server==undefined){
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Hello, client! This is the Electron HTTP server.');
    });
  
    const port = 3000;
    server.listen(port, () => {
      console.log(`Server running on http://localhost:${port}/`);
      win.webContents.send('server-status', true);
    });
  }  
}
// 关闭 HTTP 服务器
function stopServer() {
  if (server) {
    server.close(() => {
      console.log('Server stopped.');
      win.webContents.send('server-status', false);
    })
    server=undefined
  }
}

// 监听来自渲染进程的事件
ipcMain.on('toggle-server', (event, arg) => {
  if (arg === 'start') {
    startServer();
  } else if (arg === 'stop') {
    stopServer();
  }
});

//全屏按钮
ipcMain.on('toggle-fullscreen', () => {
  if (win.isFullScreen()) {
    win.setFullScreen(false);
  } else {
    win.setFullScreen(true);
  }
});

ipcMain.handle('search', async (event, path, filterText) => {
  return search(path, filterText)
});

async function search(storePath,filterText,dirPath = storePath, results = [], floor = 1) {
  if (floor > 10) return
  let filterTexts = filterText.split(" ")
  if (filterTexts.indexOf("") > -1) {
      filterTexts.splice(filterTexts.indexOf(""), 1)
  }

  let list = await fs.promises.readdir(dirPath) // 使用异步的文件读取方法

  for (let itemPath of list) {
      const fullPath = path.join(dirPath, itemPath)
      const fileStat = await fs.promises.stat(fullPath) // 使用异步的文件状态获取方法
      const isFile = fileStat.isFile()
      const dir = {
        label: path.basename(itemPath),
        path: path.join(dirPath, itemPath),
        extension: path.extname(itemPath),
      }as any

      if (!isFile) {
          await this.search(storePath, filterText, fullPath, results, floor + 1) // 使用await关键字等待异步操作的完成
      }

      let nameCount = 0
      for (let i = 0; i < filterTexts.length; i++) {
          if (dir.label.indexOf(filterTexts[i]) > -1) {
              nameCount++
          }
      }

      let contentArr = []
      let length = 12

      if (dir.extension == ".md") {
          dir.content = await fs.readFileSync(path.join(dirPath, itemPath), 'utf-8') // 使用await关键字等待异步方法的返回值

          let count = 0
          for (let i = 0; i < filterTexts.length; i++) {
              if (dir.content.indexOf(filterTexts[i]) > -1) {
              count++
              }
          }

          if (count >= filterTexts.length) {
              let index = 0
              let num = 0
              while (index != -1) {
              num++
              let nextIndex = Infinity

              for (let i = 0; i < filterTexts.length; i++) {
                  if (dir.content.indexOf(filterTexts[i], index) > -1 && dir.content.indexOf(filterTexts[i], index) < nextIndex) {
                  nextIndex = dir.content.indexOf(filterTexts[i], index)
                  }
              }

              if (nextIndex == Infinity || nextIndex == index) {
                  break
              } else if (nextIndex > index) {
                  let str = dir.content.slice(Math.max(0, nextIndex - length), Math.min(dir.content.length, nextIndex + length))
                  contentArr.push(str)
                  index = nextIndex + length
              }
              }
              dir.arr = contentArr
          }
      }

      if (nameCount >= filterTexts.length || contentArr.length > 0) {
          results.push(dir)
      }
  }

  return results
}