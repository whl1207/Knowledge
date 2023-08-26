module.exports = function() {
  const urls = require("url")
  const http = require('http')
  const mime = require('mime')
  const fs = require("fs")
  const path = require("path")
  const os = require('os')
  const yaml = require('js-yaml')

  //初始化数据
  const server = {}
  server.state=null
  server.sharePath=""
  //创建网络通信服务
  server.open= function(mainWindow,appPath){
    if(server.state!=null) return
    //读取配置文件，查找共享目录
    const configPath = path.join(appPath, './config.json');
    const configFile = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configFile);
    server.sharePath=config.sharePath;
    //console.log("服务器已开启，位置为："+config.sharePath);

    //监听请求
    server.state=http.createServer(async (req,res)=>{
      //console.log("请求到来："+req.url)
      let url=decodeURI(req.url).slice(1)
      //判断请求地址
      if(url==""){
        //如果没有参数，则返回目录结构
        res.writeHead(200,{
          'Access-Control-Allow-Origin':'*',
          'Access-Control-Allow-Headers':'Content-Type',
          'Access-Control-Allow-Methods':'*',
          'Content-Type':'application/json;charset=utf-8'
        })
        let catalogue = await getCatalogue(server.sharePath) //获取目录
        let str = JSON.stringify(catalogue) //转为字符串
        res.write(str)
        res.end("")
      }else{
        let urlobj=urls.parse(url,true)
        
        if(urlobj.query.type=="get"){
          console.log("请求类型："+url)
          //如果是要获取数据，则返回数据
          let address=path.join(server.sharePath+urlobj.query.parentPath, urlobj.query.fullName)
          let str=getFile(address)
          res.writeHead(200,{
            'Access-Control-Allow-Origin':'*',
            'Access-Control-Allow-Headers':'Content-Type',
            'Access-Control-Allow-Methods':'*',
            'Content-Type':'application/json;charset=utf-8'
          })
          res.write(str)
          res.end("")
        }else if(urlobj.query.type=="download"){
          console.log("下载类型："+url)
          //如果是要下载文件，则返回下载的文件
          let fullPath = server.sharePath+urlobj.query.parentPath+"\\"+urlobj.query.fullName
          //判断文件是否存在
          let isFile = fs.existsSync( fullPath)
          if(isFile){
            //文件头
            let realName = encodeURI(urlobj.query.fullName,"GBK")
            realName = realName.toString('iso8859-1')
            res.writeHead(200, {
              'Access-Control-Allow-Origin':'*',
              'Access-Control-Allow-Headers':'Content-Type',
              'Access-Control-Allow-Methods':'*',
              'Content-Type': 'application/force-download',
              'Content-Disposition': 'attachment; filename=' + realName
            })
            //读取文件
            let fReadStream  = fs.createReadStream(fullPath)
            fReadStream.pipe(res);
          }else{
            //找不到文件
            res.end("")
          }
        }else if(urlobj.query.type=="upload"){
          console.log('上传文件',urlobj.query.filename)
          if (req.method === 'OPTIONS') {
            // 处理 OPTIONS 请求的 CORS 头部设置
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.statusCode = 200;
            res.end();
          }else if (req.method === 'POST') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            // 创建一个可写流以保存文件
            const fileStream = fs.createWriteStream(server.sharePath+urlobj.query.path +"/"+ urlobj.query.filename);

            req.on('data', (chunk) => {
              // 将数据写入可写流
              fileStream.write(chunk);
            });

            req.on('end', () => {
              // 关闭可写流
              fileStream.end();

              res.writeHead(200, { 'Content-Type': 'text/plain' });
              res.end('File uploaded successfully!');
            });
          }
        }else if(urlobj.query.type=="domain"){
          //获取领域数据
          let fullPath = server.sharePath+urlobj.query.parentPath
          let nodes = scanDeepFile(fullPath,urlobj.query.deep,urlobj.query.showSelf)
          let data = await scanDeepData(fullPath,urlobj.query.deep,urlobj.query.showSelf,1)
          let result={
            nodes:nodes,
            edges:data.edges,
            combos:data.combos,
            config:data.config
          }
          res.writeHead(200,{
            'Access-Control-Allow-Origin':'*',
            'Access-Control-Allow-Headers':'Content-Type',
            'Access-Control-Allow-Methods':'*',
            'Content-Type':'application/json;charset=utf-8'
          })
          res.write(JSON.stringify(result))
          res.end("")
        }else if(urlobj.query.type=="search"){
          //获取领域数据
          let data = await search(server.sharePath,urlobj.query.keyword)
          res.writeHead(200,{
            'Access-Control-Allow-Origin':'*',
            'Access-Control-Allow-Headers':'Content-Type',
            'Access-Control-Allow-Methods':'*',
            'Content-Type':'application/json;charset=utf-8'
          })
          res.write(JSON.stringify(data))
          res.end("")
        }else{
          //如果要获取文件数据，直接通过网站形式返回文件内容
          filePath=server.sharePath+url
          fs.access(filePath, fs.constants.R_OK, (err) => {
            if (err) {
              res.statusCode = 404
              res.end('File not found')
              return
            }
            const contentType = mime.getType(filePath)
            const stat = fs.statSync(filePath)
            const fileSize = stat.size
            res.writeHead(200, {
              'Access-Control-Allow-Origin':'*',
              'Access-Control-Allow-Headers':'Content-Type, Authorization',
              'Access-Control-Allow-Methods':'*',
              'Content-Type': contentType,
              'Content-Length': fileSize
            })
            const fileStream = fs.createReadStream(filePath)
            fileStream.pipe(res)
          })
        }
      }
    }).listen(9000,()=>{
      console.log('服务器开启在9000端口，共享目录为'+server.sharePath);
    })
    server.state.on('close', function () {
      mainWindow.send('closeServerOver')
      //console.log('服务器已关闭', Date.now())
      server.state=null
    })
  }
  //关闭服务器
  server.close=function(){
    server.state.close()
  }

  //以下应和file.js同步
  getCatalogue=function(storePath,dirPath = server.sharePath, dirTree = [], floor = 1) {
    if (floor > 6) return
    if(!fs.existsSync( dirPath)) return //判断文件是否存在
    let ip=getLocalIP() //获取服务端ip
    let list = fs.readdirSync(dirPath)
    list = list.filter((item) => {
      return !this.isFilterPath(item)
    })
    list.forEach((itemPath) => {
      const fullPath = path.join(dirPath, itemPath)
      const fileStat = fs.statSync(fullPath)
      const isFile = fileStat.isFile()
      const dir = {
        ip:ip+":9000",
        fullPath:path.relative(storePath, fullPath),//文件夹相对对路径
        parentPath:path.relative(storePath, dirPath),//父级文件夹相对路径
        relativePath:path.relative(storePath, fullPath),//相对位置
        name:path.basename(itemPath),//文件名称（不包含后缀）
        fullName: itemPath,//文件名称（包含后缀）
        label: itemPath,//树状图中的名称
        isFolder:fs.statSync(fullPath).isDirectory(),
        type:path.extname(itemPath),//文件类型
        cloud:true,
        attributes:{}
      }
      dir.attributes = this.getConfig(fullPath) //获取配置参数
      if (!isFile) {
        dir.children = this.getCatalogue(storePath,fullPath, [], floor + 1)
      }
      dirTree.push(dir)
    })
    //console.log(dirTree)
    return dirTree
  },
  //扫描文件
  scanDeepFile=function(Path,deep,self,dirPath = Path, data = [], floor = 1){
    if (floor > deep) return data
    //判断文件是否存在
    if(!fs.existsSync( dirPath)) return []
    let ip=getLocalIP()
    //节点序号
    let i = 0
    //读取本体信息
    if(self == 1 && floor == 1){
      let dir = {
        ip:ip+":9000",
        fullPath:path.basename(Path),//文件夹绝对路径
        parentPath:path.relative(server.sharePath, path.dirname(Path)),//父级文件夹绝对路径
        relativePath:path.relative(server.sharePath, Path),//相对位置
        name:path.basename(Path),//文件名称（不包含后缀）
        fullName: path.basename(Path),//文件名称（包含后缀）
        type:"",//文件类型
        isFolder:fs.statSync(Path).isDirectory(),
        cloud:true,
        attributes:{}
      }
      //获取配置参数
      dir.attributes = this.getConfig(path.dirname(Path),path.basename(Path))
      i=i+1
      data.push(dir)
    }
    //读取下级文件夹和文件
    let list = fs.readdirSync(dirPath)
    list = list.filter((item) => {
        return !this.isFilterPath(item)
    })
    //读取和整合信息
    list.forEach((itemPath) => {
        //读取默认参数
        const fullPath = path.join(dirPath, itemPath)
        const fileStat = fs.statSync(fullPath)
        const isFile = fileStat.isFile()
        let dir = {
          ip:ip+":9000",
          fullPath:path.relative(server.sharePath, fullPath),//文件夹绝对路径
          parentPath:server.sharePath==dirPath?path.basename(dirPath):path.relative(server.sharePath, dirPath),//父级文件夹绝对路径
          relativePath:path.relative(server.sharePath, fullPath),//相对位置
          name:path.basename(itemPath),//文件名称（不包含后缀）
          fullName: itemPath,//文件名称（包含后缀）
          type:path.extname(itemPath),//文件类型
          isFolder:fileStat.isDirectory(),
          cloud:true,
          attributes:{}
        }
        //获取配置参数
        dir.attributes = this.getConfig(fullPath)
        //判断是否读取内容
        if(dir.type==".md"||dir.type==""){
            let content = this.getFile(fullPath)
            dir = {...dir,content}
        }
        i=i+1
        data.push(dir)
        if (!isFile) {
            this.scanDeepFile(Path,deep,self,fullPath, data, floor + 1)
        }
    })
    return data
  },
  //扫描深层文件，并读取配置文件
  scanDeepData=async function(Path,deep,self,readConfig,dirPath = Path,dirName,data = {edges:[],combos:[],config:[]}, floor = 1){
    if (dirName == undefined) dirName = path.basename(Path)

    //如果扫描的文件夹不存在
    if (!fs.existsSync(dirPath)) return []

    //扫描文件夹中的默认配置文件，获取默认的关系描述
    if (readConfig == 1) {
        let fullPath = dirPath+"\\"+"\\.data.json"
        let isFile = fs.existsSync(fullPath)
        if (isFile) {
            let edges = JSON.parse(fs.readFileSync(fullPath, 'utf8')).edges
            for (let i = 0; i < edges.length; i++) {
                data.edges.push(edges[i]);
            }
        }
    }
    //扫描文件夹中的其他配置文件，并将其通过数组的形式返回。
    try {
        const files = await fs.promises.readdir(dirPath); // 使用 fs.promises.readdir 方法以异步方式读取文件夹内容
        for (const file of files) {
            if (this.isFilterPath(file) && !(file == ".readme.md" || file == ".readme.json" || file == ".data.json")) {
                let tempFile = {};
                tempFile.fullPath = path.join(dirPath, file)
                let name = path.basename(tempFile.fullPath, path.extname(tempFile.fullPath))
                tempFile.name = name.slice(1, name.length)
                tempFile.type = path.extname(tempFile.fullPath)
                tempFile.content = fs.readFileSync(tempFile.fullPath,'utf8')
                tempFile.state = false
                data.config.push(tempFile)
            }
        }
    } catch (err) {
        console.error('无法读取文件夹：', err)
    }

    floor = floor + 1
    //扫描子文件夹的树形结构
    let list = fs.readdirSync(dirPath)
    list = list.filter((item) => {
        return !this.isFilterPath(item)
    })
    
    for (const itemPath of list) {
        //判断是否添加本体关系
        if ((self == 1 && floor == 2) || (floor > 2)) {
            data.edges.push({
                "source": dirName,
                "target": itemPath
            })
        }
        //如果扫描的层次没有到达指定深度
        if (floor <= deep) {
            const fullPath = path.join(dirPath, itemPath)
            const fileStat = fs.statSync(fullPath)
            const isFile = fileStat.isFile()
            //判断是否为文件夹，如果时文件夹向下扫描
            if (!isFile) {
                await this.scanDeepData(Path, deep, self, readConfig, fullPath, itemPath, data, floor); // 递归调用 scanDeepData，使用 await 等待结果
            }
        }   
    }
    return data
  },
  search = async function(storePath,filterText,dirPath = storePath, results = [], floor = 1) {
    if (floor > 10) return
    //分拆关键词
    let filterTexts=filterText.split(" ")
    if(filterTexts.indexOf("")>-1){
        filterTexts.splice(filterTexts.indexOf(""),1)
    }
    //读取文件列表
    let list = fs.readdirSync(dirPath)
    list = list.filter((item) => {
        return !this.isFilterPath(item)
    });
    list.forEach((itemPath) => {
        const fullPath = path.join(dirPath, itemPath)
        const fileStat = fs.statSync(fullPath)
        const isFile = fileStat.isFile()
        const dir = {
            fullPath:fullPath,//文件夹绝对路径
            parentPath:dirPath,//父级文件夹绝对路径
            name:path.basename(itemPath),//文件名称（不包含后缀）
            fullName: itemPath,//文件名称（包含后缀）
            type:path.extname(itemPath),//文件类型
            cloud:true
        }
        //如果是文件夹，进一步搜索
        if (!isFile) {
            this.search(storePath,filterText,fullPath, results, floor + 1)
        }
        //搜索名称和类型
        let nameCount=0
        for(let i=0;i<filterTexts.length;i++){
            if(dir.fullName.indexOf(filterTexts[i])>-1){
                nameCount++
            }
        }
        //内容片段构成的数组
        let contentArr=[]
        let length=12 //判断间隔
        if(dir.type==".md"){
            //读取文件内容
            dir.content = this.getFile(fullPath)
            //判断内容是否包含所有关键词
            let count=0
            //记录包含的个数
            for(let i=0;i<filterTexts.length;i++){
                if(dir.content.indexOf(filterTexts[i])>-1){
                    count++
                }
            }
            //关键词每个至少包含一个才继续统计
            if(count>=filterTexts.length){
                let index = 0
                let num = 0
                while (index != -1) {
                    num++//找到的次数
                    //记录未找到的内容中最小的序号
                    let nextIndex=Infinity
                    //找到所有关键词
                    for(let i=0;i<filterTexts.length;i++){
                        //如果找到了序号
                        if(dir.content.indexOf(filterTexts[i],index)>-1&&dir.content.indexOf(filterTexts[i],index)<nextIndex){
                            nextIndex=dir.content.indexOf(filterTexts[i],index)
                        }
                    }
                    //如果没找到了下个关键字所在序号
                    if(nextIndex==Infinity||nextIndex==index){
                        break
                    }else if(nextIndex>index){
                        //如果找到了下个关键字所在序号
                        let str=dir.content.slice(Math.max(0,nextIndex-length),Math.min(dir.content.length,nextIndex+length))
                        contentArr.push(str)
                        index = nextIndex+length
                    }                        
                }
                dir.arr=contentArr
            }
        }
        //记录搜索到的结果
        if(nameCount>=filterTexts.length||contentArr.length>0){
            results.push(dir)
        }
    })
    return results
  },
  //获取配置文件
  getConfig=function(fullPath){
    let isFolder=fs.statSync(fullPath).isDirectory()
    fullPath = isFolder?(fullPath+"\\.readme.md"):(fullPath)
    if(path.extname(fullPath)!='.md') return {}
    let isFile = fs.existsSync(fullPath) //判断文件是否存在
    if(isFile){
      const fileContent = fs.readFileSync(fullPath, 'utf8')
      const matches = fileContent.match(/^---\r?\n([\s\S]+?)\r?\n---/) // 如果找到匹配项，则解析YAML头
      if (matches && matches.length > 1) {
        // 提取YAML头的内容
        const yamlHeader = matches[1];
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
  }
  //储存配置文件
  saveConfig=function(fullPath,data){
    let isFolder=fs.statSync(fullPath).isDirectory()
    fullPath = isFolder?(fullPath+"\\.readme.md"):(fullPath)
    if(path.extname(fullPath)!='.md') return {}
    const yamlSeparator = '---\n'
    const updatedYamlContent = yaml.dump(data) //将data转为yaml字符串
    //判断是否有文件
      if (fs.existsSync(fullPath)) {
          try {
              //如果有md文件
              const content = fs.readFileSync(fullPath, 'utf8') //读取文件内容
              const yamlEndIndex = content.indexOf(yamlSeparator, yamlSeparator.length)-1
              const updatedContent = `${yamlSeparator}${updatedYamlContent}${yamlSeparator}${content.substring(yamlEndIndex + yamlSeparator.length+1)}` //+1是为了去除/n
              try {
                  fs.writeFileSync(fullPath, updatedContent,'utf8')
                  return true
              } catch (err) {
                  console.log(err)
                  return false
              }
          } catch (error) {
            console.error('文件没有读取权限:', error);
          }
      } else {
          const updatedContent = `${yamlSeparator}${updatedYamlContent}${yamlSeparator}` //+1是为了去除/n
          try {
              fs.writeFileSync(fullPath, updatedContent,'utf8');
              return true
          } catch (err) {
              console.log(err)
              return false
          }
      }
  }
  //输出相对库文件夹的相对路径
  getPartPath=function(Path) {
    let base = server.sharePath.split(/\/|\\/g)
    Path = Path.split(/\/|\\/g)
    while (base.length && Path.length && base[0] === Path[0]) {
      base.shift()
      Path.shift()
    }
    return Path.join('\\')
  }
  //过滤文件
  isFilterPath=function(item) {
    let filterFile = ["\\..*"]
    for (let i = 0; i < filterFile.length; i++) {
      let reg = filterFile[i]
      if (item.match(reg) && item.match(reg)[0] === item) return true
    }
    return false
  }
  //读取文件内容
  getFile =function(fullPath){
    let isFolder=fs.statSync(fullPath).isDirectory()
    fullPath = isFolder?(fullPath+"\\.readme.md"):(fullPath)
    //判断文件是否存在
    let isFile = fs.existsSync(fullPath)
    if(isFile){
        return fs.readFileSync(fullPath,'utf8')
    }else{
        return ''
    }
  }
  function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name in interfaces) {
      const interface = interfaces[name];
      for (let i = 0; i < interface.length; i++) {
        const { address, family, internal } = interface[i];
        if (family === 'IPv4' && !internal) {
          return address;
        }
      }
    }
    return '127.0.0.1';
  }
  return server
}

