export default {
    //扫描目录
    getCatalogue(storePath,dirPath = storePath, dirTree = [], floor = 1) {
        const fs = require("fs")
        const path = require("path")
        if (floor > 6) return
        if(!fs.existsSync( dirPath)) return //判断文件是否存在
        let list = fs.readdirSync(dirPath)
        list = list.filter((item) => {
            return !this.isFilterPath(item)
        });
        list.forEach((itemPath) => {
            const fullPath = path.join(dirPath, itemPath)
            const fileStat = fs.statSync(fullPath)
            const isFile = fileStat.isFile()
            const dir = {
                fullPath:path.join(dirPath, itemPath),//文件夹绝对路径
                parentPath:dirPath,//父级文件夹绝对路径
                relativePath:path.relative(storePath, fullPath),//相对位置
                name:path.basename(itemPath).replace(/\.[^/.]+$/, ''),//文件名称（不包含后缀）
                fullName: itemPath,//文件名称（包含后缀）
                label: itemPath,//树状图中的名称
                isFolder:fs.statSync(fullPath).isDirectory(),
                type:path.extname(itemPath),//计算文件类型
                cloud:false,
                content:'',
                attributes:{}
            }
            dir.attributes = this.getConfig(dir.fullPath) //获取配置参数
            if (!isFile) {
                dir.children = this.getCatalogue(storePath,fullPath, [], floor + 1)
            }
            dirTree.push(dir)
        })
        //console.log(dirTree)
        return dirTree
    },
    //扫描深层文件，并读取节点的配置信息
    scanDeepFile(Path,deep,self,dirPath = Path, data = [], floor = 1){
        //参数为路径，扫描深度，是否扫描自己
        const fs = require("fs")
        const path = require("path")

        if (floor > deep) return data
        //判断文件是否存在
        if(!fs.existsSync( dirPath)) return []
        //节点序号
        let i = 0
        //读取本体信息
        //console.log(self,floor)
        if(self == 1 && floor == 1){
            let dir = {
                id:i,
                fullPath:Path,//文件夹绝对路径
                parentPath:path.dirname(Path),//父级文件夹绝对路径
                name:path.basename(Path).replace(/\.[^/.]+$/, ''),//文件名称（不包含后缀）
                fullName: path.basename(Path),//文件名称（包含后缀）
                type:path.extname(Path),//文件类型
                isFolder:fs.statSync(Path).isDirectory(),
                cloud:false,
                content:'',
                attributes:{}
            }
            //获取配置参数
            dir.attributes = this.getConfig(Path)
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
                id:i,
                fullPath:path.join(dirPath, itemPath),//文件夹绝对路径
                parentPath:dirPath,//父级文件夹绝对路径
                name:path.basename(itemPath).replace(/\.[^/.]+$/, ''),//文件名称（不包含后缀）
                fullName: itemPath,//文件名称（包含后缀）
                type:path.extname(itemPath),//文件类型
                isFolder:fileStat.isDirectory(),
                cloud:false,
                content:'',
                attributes:{}
            }
            //获取配置参数
            dir.attributes = this.getConfig(dir.fullPath)
            //判断是否读取内容
            if(dir.type==".md"||dir.type==""){
                let content = this.getFile(dir.fullPath)
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
    //扫描深层配置文件，用于扫描边、组合和配置文件
    async scanDeepData(Path,deep,self,dirPath = Path,dirName,data = {edges:[],combos:[],config:[]}, floor = 1){
        const fs = require("fs")
        const path = require("path")
        if (dirName == undefined) dirName = path.basename(Path)

        //如果扫描的文件夹不存在
        if (!fs.existsSync(dirPath)) return []

        //扫描文件夹中的其他配置文件，并将其通过数组的形式返回。
        try {
            const files = await fs.promises.readdir(dirPath); // 使用 fs.promises.readdir 方法以异步方式读取文件夹内容
            for (const file of files) {
                if (this.isFilterPath(file) && path.extname(file).toLowerCase() === '.csv') {
                    let tempFile = {}
                    tempFile.fullPath = path.join(dirPath, file)
                    let name = path.basename(tempFile.fullPath, path.extname(tempFile.fullPath))
                    tempFile.name = name.slice(1, name.length)
                    tempFile.type = path.extname(tempFile.fullPath)
                    tempFile.color = '#aaaaaa66'
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
                    await this.scanDeepData(Path, deep, self, fullPath, itemPath, data, floor); // 递归调用 scanDeepData，使用 await 等待结果
                }
            }   
        }
        return data
    },
    //判断文件是否存在
    ifExist(path) {
        const fs = require("fs")
        if(fs.existsSync( path)){
            return true
        }else{
            return false
        }
    },
    //过滤文件
    isFilterPath(item) {
        let filterFile = ["\\..*"]
        for (let i = 0; i < filterFile.length; i++) {
            let reg = filterFile[i]
            if (item.match(reg) && item.match(reg)[0] === item) return true
        }
        return false
    },
    //创建文件夹
    createFolder(path){
        const fs = require("fs")
        fs.mkdirSync(path);
    },
    //创建文件
    createFile(path,name,data){
        const fs = require("fs")
        let fullPath=path+"\\"+name
        //console.log(fullPath)
        fs.writeFileSync(fullPath, data, function (err) { 
            if (err) throw err; 
        });
    },
    //重命名文件
    renameFile(oldName,newName){
        const fs = require("fs")
        fs.renameSync(oldName,newName,function (err) { 
            if (err) throw err; 
            //console.log('File Renamed.'); 
        })
    },
    //复制文件
    copy(sourceFile,destPath){
        //参数为需要复制的文件和复制到的文件夹路径
        const fs = require("fs")
        const path = require("path")
        return new Promise((resolve, reject) => {
            const fileName = path.basename(sourceFile);
            const destFilePath = path.join(destPath, fileName);

            const readStream = fs.createReadStream(sourceFile)
            const writeStream = fs.createWriteStream(destFilePath)
            readStream.on("error", (error) => {
              reject(`无法读取源文件: ${error}`)
            })
            writeStream.on("error", (error) => {
              reject(`无法写入目标文件: ${error}`)
            })
            writeStream.on("finish", () => {
              resolve("文件上传成功");
            })
            readStream.pipe(writeStream)
        })
    },
    //移动文件
    move(sourceFile,destPath){
        const fs = require("fs")
        const path = require("path")
        
        //判断目标是否为文件夹
        let destStat = fs.statSync(destPath)
        if (!destStat.isDirectory()) return

        const fileName = path.basename(sourceFile)
        const destFilePath = path.join(destPath, fileName)

        fs.rename(sourceFile, destFilePath, function (err) {
            if (err) throw err
            fs.stat(destPath, function (err, stats) {
                if (err) throw err
            })
        })
    },
    //删除文件
    delFile(path){
        const fs = require("fs")
        let fileStat = fs.statSync(path)
        let isFile = fileStat.isFile()
        if(isFile){
            fs.unlinkSync(path, function (err) { 
                if (err) throw err; 
            });
        }else{
            fs.rmdirSync(path);
        }
    },
    //用默认应用打开文件
    openFileByDefault(path){
        if(path!=""){
            const fs = require("fs")
            fs.exists(path, (exists) => {
                let shell = require("electron").shell
                if (exists) shell.openPath(path)
            })
        }
    },
    //打开文件所在位置
    openPath(path){
        if(path!=""){
        //console.log(path)
        const fs = require("fs")
        fs.exists(path, (exists) => {
            let shell = require("electron").shell
            if (exists) shell.showItemInFolder(path)
        });
        }
    },
    //读取文件内容
    getFile (fullPath){
        const fs = require("fs")
        const path = require("path")
        let isFolder=fs.statSync(fullPath).isDirectory()
        fullPath = isFolder?(fullPath+"\\.readme.md"):(fullPath)
        //判断文件是否存在
        let isFile = fs.existsSync(fullPath)
        if(isFile){
            return fs.readFileSync(fullPath,'utf8')
        }else{
            return ''
        }
    },
    //储存文件内容
    saveFile (fullPath,data){
        const fs = require("fs")
        let isFolder=fs.statSync(fullPath).isDirectory()
        fullPath = isFolder?(fullPath+"\\.readme.md"):(fullPath)
        try {
            fs.writeFileSync(fullPath, data,{ encoding: 'utf8', flag: 'w', newline: 'lf' },)
            return true
        } catch (err) {
            console.log(err)
            return false
        }
    },
    //获取配置文件
    getConfig(fullPath){
        const fs = require("fs")
        const path = require("path")
        const yaml = require('js-yaml')
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
    },
    //储存配置文件
    saveConfig (fullPath,data){
        const fs = require("fs")
        const path = require("path")
        let isFolder=fs.statSync(fullPath).isDirectory()
        fullPath = isFolder?(fullPath+"\\.readme.md"):(fullPath)
        if(path.extname(fullPath)!='.md') return false
        const yaml = require('js-yaml')
        
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
    },
    //获取数据文件位置，path父文件夹路径，只读取领域数据
    getDataAddress(path){
        let fullPath = path+"\\"+"\\.data.json"
        return fullPath
    },
    //获取配置文件
    getData(path){
        let fullPath = this.getDataAddress(path)
        const fs = require("fs")
        let isFile =fs.existsSync(fullPath)
        if(isFile){
            return fs.readFileSync(fullPath,'utf8')
        }else{
            //返回默认空数据
            return '{"edges":[],"combos":[]}'
        }
    },
    //储存配置文件
    saveData (path,data){
        let fullPath = this.getDataAddress(path)
        const fs = require("fs")
        fs.writeFile(fullPath, data, function(error) { 
            if (error) { 
                return false
            } else { 
                return true
            } 
        })
    },
    
    //搜索文件
    async search(storePath,filterText,dirPath = storePath, results = [], floor = 1) {
        if (floor > 10) return
        let filterTexts = filterText.split(" ")
        if (filterTexts.indexOf("") > -1) {
            filterTexts.splice(filterTexts.indexOf(""), 1)
        }

        const fs = require("fs")
        const path = require("path")

        let list = await fs.promises.readdir(dirPath) // 使用异步的文件读取方法
        list = list.filter((item) => {
            return !this.isFilterPath(item)
        })

        for (let itemPath of list) {
            const fullPath = path.join(dirPath, itemPath)
            const fileStat = await fs.promises.stat(fullPath) // 使用异步的文件状态获取方法
            const isFile = fileStat.isFile()
            const dir = {
                fullPath: path.join(dirPath, itemPath),
                parentPath: dirPath,
                relativePath:path.relative(storePath, fullPath),//相对位置
                name: path.basename(itemPath),
                fullName: itemPath,
                type: path.extname(itemPath),
                cloud:false
            }

            if (!isFile) {
                await this.search(storePath, filterText, fullPath, results, floor + 1) // 使用await关键字等待异步操作的完成
            }

            let nameCount = 0
            for (let i = 0; i < filterTexts.length; i++) {
                if (dir.fullName.indexOf(filterTexts[i]) > -1) {
                    nameCount++
                }
            }

            let contentArr = []
            let length = 12

            if (dir.type == ".md") {
                dir.content = await this.getFile(path.join(dirPath, itemPath)) // 使用await关键字等待异步方法的返回值

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
    },
}