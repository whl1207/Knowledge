<script setup lang="ts">

  //加载视图组件
  import {usestore} from '../../store'
  import { nextTick, ref ,onMounted,onBeforeUnmount, reactive,watch,onErrorCaptured} from 'vue'
  import G6 from '@antv/g6'
  import file from '../../../electron/file'
import { Loading } from 'element-plus/es/components/loading/src/service';
  const store=usestore()

  //错误处理函数
  const handleError = error => {
    // 处理错误的函数逻辑
    // 在这里可以执行你想要的操作，比如发送错误日志等
    console.error('处理错误:', error);
    window.location.reload();
    // 这里可以执行你希望的任何操作
  }
  onErrorCaptured(handleError);
  let controlPanel=ref(false)//显示控制面板
  let controlPanelType=ref("设置")//数据显示类型
  let updateingLayout=ref(false)//显示正在更新布局
  //所有图谱设置
  let atlas=ref({}) as any
  
  atlas.value.deep=1 //是否深层扫描，扫描子文件夹数据
  atlas.value.showTree=1 //是否显示树形结构，自动关联文件夹和子文件夹数据
  atlas.value.showSelf=1 //是否读取本体，默认读取
  atlas.value.AggregateDuplicates=1 //聚合重名，相同文件名看作一个节点
  atlas.value.watchPath=0 //是否监听path变化
  atlas.value.result=[]//搜索结果
  atlas.value.config=[] //配置文件数组
  atlas.value.attributes=[] //文件属性数组
  atlas.value.nodeIndex = -1
  atlas.value.edgeIndex = -1
  atlas.value.comboIndex = -1
  
  //图谱中的节点和边的数据
  let db = reactive({
    nodes: [] as any[],// 点集
    edges: [] as any[],// 边集
    combos: [] as any[],// 组合集
  })
  //图谱设置
  atlas.value.set={
    //通用设置
    view:"mode",//工具面板标签
    mode:"浏览模式",//图谱操作模式
    keyword:"",//搜索关键词

    //节点设置
    NodeLabel:true,//标签是否显示
    NodeLabelRestrict:false,
    NodeSizeMode:"一致",
    NodeColor:'彩色',
    NodeLabelColor:document.documentElement.style.getPropertyValue("--fontColor"),//节点标签颜色
    //边设置
    EdgeShow:true,
    EdgeLabel:true,
    EdgeEdit:false,//是否编辑链接
    EdgeType:"",//链接类型
    EdgeColor:'#aaaaaa66',//边颜色
    EdgeLabelColor:document.documentElement.style.getPropertyValue("--fontActiveColor"),
    //组合设置
    ComboShow:true,//是否显示组合
    ComboLabel:true,//是否显示组合标签
    comboEdit:false,//是否编辑组合
    ComboLabelColor:document.documentElement.style.getPropertyValue("--fontActiveColor"),
    ComboBackgroundColor:'rgba(200,200,200,0.2)',
    //工具设置
    iffisheye:false,//是否使用鱼眼
    ifgrid:false,//是否显示网格
  }
  //图谱布局类型
  atlas.value.layout={
    type: 'dagre',
    //GPU绘图
    //gpuEnabled: true,
    //防止阻塞
    //workerEnabled:true,
    //通用
    preventOverlap: true,//不重叠
    nodeSize: 90,
    //center: [100, 100], //图中心

    //force
    linkDistance:80,//边长度
    nodeStrength: 50,//节点作用力
    edgeStrength: 0.2,//边的作用力
    collideStrength: 0.8,//防止重叠的力强度，范围 [0, 1]
    //alpha: 0.3,//当前的迭代收敛阈值
    //alphaDecay: 0.028,//迭代阈值的衰减率。范围 [0, 1]。0.028 对应迭代数为 300
    //alphaMin: 0.01,//停止迭代的阈值
    //forceSimulation: null, //自定义 force 方法，若不指定，则使用 d3.js 的方法

    //gFroce
    //ForceAtlas2
    kr:35,
    kg:5,
    ks:10,
    
    //radial
    unitRadius:200,
    maxIteration: 1000,
    //dagre
    rankdir: 'TB', //布局方向
    nodesep: 22, //节点间距
    ranksep: 15, //层间距

    //concentric
    radius:200, //同心圆

    //fruchterman
    speed: 10,
    gravity: 5,
    //comboForce
    nodeSpacing: (d:any) => 20,
    onTick: () => {
      //graph.refreshPositions()
    },
    onLayoutEnd: () => {// 布局完成
      //console.log('force layout done');
    },
  }

  atlas.value.defaultNode={
    type: "circle",
    size: [25, 25],
    style: {
      fill: 'rgba(200,200,200,0.2)',
      stroke: '#999999',
      lineWidth: 1,
      radius: 5
    },
    anchorPoints: [
      [0.5, 0.5],
    ],
    labelCfg: {
      position: 'bottom',
      offset: 8,
      style:{
        fill: atlas.value.set.NodeLabelColor,
        fontSize: 10
      }
    },
  }

  //配置图
  atlas.value.Option={
    container: 'mountNode', // String | HTMLElement，必须，在 Step 1 中创建的容器 id 或容器本身
    width: 0, // Number，必须，图的宽度
    height: 0, // Number，必须，图的高度
    animate: true,//动画布局
    minZoom: 0.00000001,//缩放比例
    plugins:[] as any,//插件
    fitCenter: true,//居中
    gpuEnabled: false,//使用gpu绘图
    layout: atlas.value.layout,
    modes: {
      default: [
        'click-select',
        'drag-canvas',//画布拖动
        //{
          //type: 'activate-relations',
          //resetSelected: true,
          //trigger:'click'
        //},
        {
          type: 'zoom-canvas',//画布缩放
        },
        /**
        {
          type: 'tooltip', // 提示框
          formatText(model:any) {
            // 提示框文本内容
            const text = model.data.name 
            return text
          },
        },
        {
          type: 'edge-tooltip', // 边提示框
          formatText(model:any) {
            // 边提示框文本内容
            const text = model.source + "->" +model.target
            return text
          },
        } */
      ],
      NodeEdit:[
        'click-select',
        'drag-node',//拖动点
        'drag-combo',//组合拖动
        {//点击combo的行为
          type: 'collapse-expand-combo',
          trigger: 'dblclick',
          relayout: false, // 收缩展开后，不重新布局
        },
        {
          type: 'brush-select',
          trigger: 'drag',
        },
        {
          type: 'zoom-canvas',//画布缩放
        },
      ],
      EdgeEdit:[
        {//创建边
          type: 'create-edge',
          trigger: 'drag', // 'click' by default. options: 'drag', 'click'
        },
        {
          type: 'zoom-canvas',//画布缩放
        },
      ]
    },
    defaultNode: atlas.value.defaultNode,
    nodeStateStyles: {
      hover: {
        fill: 'rgba(200,200,200,0.9)',
        stroke: 'rgba(200,200,200,0.9)',
      },
      selected:{
        opacity: 0.9,
        fill: 'rgba(200,200,200,0.2)',
        stroke: 'rgba(200,200,200,0.9)',
      },
      active:{//浮入链接的节点状态
        opacity: 0.8,
        fill: 'rgba(200,200,200,0.3)',
        stroke: 'rgba(200,200,200,0.9)',
      },
      inactive:{//浮入未被链接的节点状态
        opacity: 0.1,
      }
    },
    defaultEdge: {
      type: atlas.value.set.EdgeType,
      style: {
        stroke: atlas.value.set.EdgeColor,
        lineWidth:2,
        endArrow: {
          path: G6.Arrow.triangle(5, 10, 10), // 使用内置箭头路径函数，参数为箭头的 宽度、长度、偏移量（默认为 0，与 d 对应）
          d: 10
        },
      },
      labelCfg: {
        autoRotate: true,
        style: {
          fill: atlas.value.set.EdgeLabelColor,
          fontSize:10
        },
        refY:6
      },
    },
    edgeStateStyles: {
      hover: {
        fill: 'rgba(200,200,200,0.9)',
      },
      selected:{
        stroke:'rgba(200,200,200,0.6)',
      },
      active:{//浮入链接的节点状态
        stroke:'rgba(200,200,200,0.9)',
        lineWidth: 3
      },
      inactive:{//浮入未被链接的节点状态
        stroke:'rgba(200,200,200,0.05)',
        lineWidth: 1
      }
    },
    defaultCombo:{
      type:"circle",//circle,rect
      style: {
        fill: atlas.value.set.ComboBackgroundColor,
      },
      labelCfg: {
        style: {
          fill: atlas.value.set.ComboLabelColor,
        },
      },
    },
    comboStateStyles: {
      selected:{
        fill: 'rgba(200,200,200,0.5)',
        stroke:'rgba(200,200,200,0.5)',
      },
      active:{//浮入链接的节点状态
        fill: 'rgba(200,200,200,0.3)',
        stroke:'rgba(200,200,200,0.3)',
      },
      inactive:{//浮入未被链接的节点状态
        fill: 'rgba(200,200,200,0.1)',
      }
    },
  }

  //绘图变量
  let graph=null as any
  //注册动画边
  G6.registerEdge(
    'circle-running',
    {
      afterDraw(cfg, group:any) {
        const shape = group.get('children')[0];
        const startPoint = shape.getPoint(0);
        const circle = group.addShape('circle', {
          attrs: {
            x: startPoint.x,
            y: startPoint.y,
            fill: '#F6BD16',
            r: 3,
          },
          name: 'circle-shape',
        });

        circle.animate(
          (ratio:any) => {
            const tmpPoint = shape.getPoint(ratio);
            return {
              x: tmpPoint.x,
              y: tmpPoint.y,
            };
          },
          {
            repeat: true, 
            duration: 3000,
          },
        );
      },
    },
    'cubic',
  )
  
  //鱼眼工具
  let fisheye = new G6.Fisheye({
    d: 1.5,
    r: 300,
    showLabel: true,
  })
  let grid = new G6.Grid()
  //字符串截取
  const fittingString = (str:any, maxWidth:any, fontSize:any) => {
    const ellipsis = '...'
    const ellipsisLength = G6.Util.getTextSize(ellipsis, fontSize)[0]
    let currentWidth = 0
    let res = str
    const pattern = new RegExp('[\u4E00-\u9FA5]+') // distinguish the Chinese charactors and letters
    if(str==undefined) return''
    str.split('').forEach((letter:any, i:any) => {
      if (currentWidth > maxWidth - ellipsisLength) return
      if (pattern.test(letter)) {
        // Chinese charactors
        currentWidth += fontSize
      } else {
        // get the width of single letter according to the fontSize
        currentWidth += G6.Util.getLetterWidth(letter, fontSize);
      }
      if (currentWidth > maxWidth - ellipsisLength) {
        res = `${str.substr(0, i)}${ellipsis}`
      }
    })
    return res
  }
  //初始化图
  const InitGraph=async function(){
    //清空绘图
    if(graph!=null) graph.destroy()
    await nextTick()
    //动画遮罩
    updateingLayout.value=true
    //判断路径是否是文件夹
    if(store.app.environment!="web"){
      //如果是electron环境
      //如果未设定仓库和路径
      if(store.app.path=="") return
      const fs = require("fs")
      const state = fs.existsSync(store.app.path)//判断是不是有这个文件或者文件夹
      if(state){
        //初始化图布局配置，获取节点和边的信息
        store.app.data.nodes = await file.scanDeepFile(store.app.path,atlas.value.deep,atlas.value.showSelf)
        getAttributes()
        db.nodes = filterNode(store.app.data.nodes)
        let data = await file.scanDeepData(store.app.path,atlas.value.deep,atlas.value.showSelf)! as any
        db.edges = filterEdge(data.edges) as any
        db.combos=filterCombo()
        atlas.value.config=data.config
        graph = new G6.Graph(atlas.value.Option) //生成图
        graph.data(db) //根据数据生成图
        graph.render() //渲染图
        
        changeConfig(null) //设定关系
        onNodeSizeMode() //修改节点大小
        graphBehavior() //设置图的行为
        resizeAtlas() //设置图大小
      }else{
        console.log("文件不存在")
      }
    }else{
      //如果是网页端环境
      try {
        let str = await store.getCloudData(store.app.path,atlas.value.deep,atlas.value.showSelf) as any
        let data = JSON.parse(str)
        store.app.data.nodes = data.nodes
        getAttributes()
        db.nodes = filterNode(data.nodes)
        db.edges = filterEdge(data.edges) as any
        atlas.value.config = data.config //配置信息

        graph = new G6.Graph(atlas.value.Option) //生成图
        graph.data(db) //根据数据生成图
        graph.render() //渲染图
        changeConfig(null) //设定关系
        onNodeSizeMode() //修改节点大小
        graphBehavior() //设置图的行为
        resizeAtlas() //设置图大小
      } catch (error) {
        // 处理错误情况
        console.error(error)
      }
    }
  }
  const graphBehavior = function(){
    graph.on('node:dragstart', function (e:any) {
      if(atlas.value.set.mode!="节点编辑") return
      if(atlas.value.layout.type=="force"||atlas.value.layout.type=="gForce"){
        //graph.layout();
        refreshDragedNodePosition(e)
      }
    })
    graph.on('node:drag', function (e:any) {
      if(atlas.value.set.mode!="添加链接"){
        if(atlas.value.layout.type=="force"||atlas.value.layout.type=="gForce"){
          refreshDragedNodePosition(e)
        }
      }
    });
    graph.on('node:dragend', function (e:any) {
      if(atlas.value.set.mode!="添加链接"){
        const forceLayout = graph.get('layoutController').layoutMethods[0];
        forceLayout.execute()
        if(atlas.value.layout.type=="force"||atlas.value.layout.type=="gForce"){
          e.item.get('model').fx = null
          e.item.get('model').fy = null
        }
      }
    });
    //节点点击行为
    graph.on('node:click', function (e:any) {
      // 阻止浏览器默认的右键菜单
      e.preventDefault()
      //显示关系
      clickNode(e.item.get('id'),false)
    })
    //节点右键行为
    graph.on('node:contextmenu', function (e:any) {
      e.preventDefault()
      const node = e.item
      //获取序数
      for(let i = 0;i<db.nodes.length;i++){
        if(node.get('id')==db.nodes[i].id){
          atlas.value.nodeIndex= i
        }
      }
      // 显示自定义的右键菜单
      const menu = document.getElementById("nodeMenu") as any
      menu.style.left = e.clientX + 'px'
      menu.style.top = e.clientY + 'px'
    })
    graph.on('node:touchstart', function (e:any) {
      const node = e.item
      //获取序数
      for(let i = 0;i<db.nodes.length;i++){
        if(node.get('id')==db.nodes[i].id){
          atlas.value.nodeIndex= i
        }
      }
      console.log(atlas.value.nodeIndex)
      // 显示自定义的右键菜单
      const menu = document.getElementById("nodeMenu") as any
      menu.style.left = e.clientX + 'px'
      menu.style.top = e.clientY + 'px'
      console.log(menu)
    })
    //节点双击事件，打开编辑器
    graph.on('node:dblclick', (ev:any) => {
      if(ev.item?._cfg.id){
        //console.log(ev.item._cfg)
        store.addTab(ev.item._cfg.model.data)
        atlas.value.nodeIndex=-1
      }
    })
    //创建边
    graph.on('aftercreateedge', (e:any) => {
      const edges = graph.save().edges
      edges[edges.length-1].index=edges.length-1
      //store.addLink(edges[edges.length-1].source,edges[edges.length-1].target)
      //store.data.set.edgeIndex=edges.length-1
      graph.layout()
    })
    //
    graph.on('edge:click', (e:any) => {
      const edge = e.item;
      clickEdge(edge.get('id'),false)
    })
    graph.on('canvas:click', (evt:any) => {
      graph.getEdges().forEach((edge:any) => {
        graph.clearItemStates(edge);
      })
      graph.getNodes().forEach((node:any) => {
        graph.clearItemStates(node);
      })
      atlas.value.set.keyword=""
      //重置点击序数
      atlas.value.nodeIndex=-1
      //根据标签参数设置标签的显隐
      updateLabelStyle()
    })
    graph.on('canvas:contextmenu', (evt:any) => {
      atlas.value.set.keyword=""
      atlas.value.nodeIndex=-1
    })
    graph.on('canvas:touchstart', (evt:any) => {
      atlas.value.set.keyword=""
      //重置点击序数
      atlas.value.nodeIndex=-1
    })
    //节点点击行为
    graph.on('combo:click', function (e:any) {
      //console.log(e.item)
      //store.data.set.comboIndex=e.item.getModel().index
      graph.focusItem(e.item)
      //store.data.set.nodeIndex=-1
      //store.data.set.edgeIndex=-1
    })
    
    graph.on('afteradditem', (evt:any) => {
      //console.log('创建了数据')
    })
    graph.on('afterlayout', () => {
      // 显示计算动画
      updateingLayout.value=false
    })
  }
  const refreshDragedNodePosition=function (e:any) {
    const model = e.item.get('model')
    model.fx = e.x
    model.fy = e.y
  }

  //节点过滤
  const filterNode = function(data:any){
    let arr = [] as any[]
    for(let i=0;i<data.length;i++){
      let temp = {} as any
      if(atlas.value.AggregateDuplicates==1){
        temp.id=data[i].fullName
      }else{
        temp.id="node_"+i
      }
      if(atlas.value.set.NodeColor=='彩色'){
        if (!temp.style) temp.style = {}
        if(data[i].attributes.节点颜色!=undefined){
          temp.style.fill = data[i].attributes.节点颜色
          temp.style.stroke = data[i].attributes.节点颜色
        }
      }
      if(atlas.value.set.NodeLabel){
        if(atlas.value.set.NodeLabelRestrict){
          temp.label=fittingString(data[i].name,100,12) //限制标签长度
        }else{
          temp.label=data[i].name
        }
      }
      temp.data=data[i]
      temp.comboId=data[i].comboId
      temp.size=[25,25]
      arr.push(temp)
    }
    return arr
  }
  //边过滤
  const filterEdge = function(edges:any){
    //传递树状信息
    if(atlas.value.showTree==1){
      let arr = [] as any[]
      if(!atlas.value.set.EdgeShow) return arr
      for(let i=0;i<edges.length;i++){
        //获取边属性
        let temp = {
            index:db.edges.length,
            source:edges[i].source.toString(),
            target:edges[i].target.toString(),
            label:atlas.value.set.EdgeLabel?edges[i].label:'',
            style:{
              stroke:atlas.value.set.EdgeColor
            },
            content:edges[i].content
        } as any
        arr.push(temp)
      }
      return arr
    }else{
      return []
    }
  }
  //组合过滤
  const filterCombo = function(){
    let data = JSON.parse(file.getData(store.app.path)).combos
    const arr = [] as any[]
    if(!atlas.value.set.ComboShow) return arr
    for(let i=0;i<data.length;i++){
      const temp = {} as any
      temp.id=data[i].id
      if(atlas.value.set.ComboLabel) temp.label=data[i].label
      temp.index=i
      temp.content=data[i].content
      if(data[i].parentId!=undefined) temp.parentId=data[i].parentId
      arr.push(temp)
    }
    return arr
  }
  //修改布局类型
  const updateLayoutType=function(){
    if(atlas.value.layout.type=='force'){
      atlas.value.layout.linkDistance=100//边长度
      atlas.value.layout.nodeStrength=100//节点作用力
      atlas.value.layout.edgeStrength=2//边的作用力
      atlas.value.layout.maxIteration=1000
    }else if(atlas.value.layout.type=='gForce'){
      atlas.value.layout.linkDistance=1//边长度
      atlas.value.layout.nodeStrength=1000//节点作用力
      atlas.value.layout.edgeStrength=200//边的作用力
      atlas.value.layout.maxIteration=1000
    }else if(atlas.value.layout.type=='mds'){
      atlas.value.layout.linkDistance=200//边长度
    }else if(atlas.value.layout.type=='comboForce'){
      atlas.value.layout.maxIteration=500
      atlas.value.layout.linkDistance=10
      atlas.value.layout.nodeStrength=20
      atlas.value.layout.edgeStrength=1
      atlas.value.layout.gravity=20
      atlas.value.layout.comboGravity=30
    }
    updateLayout()
  }
  //更新数据
  const updateData=function(){
    updateingLayout.value=true
    graph.changeData(db)
    //graph.render()
    //render后会更新位置
  }
  //更新布局参数
  const updateLayout=function(){
    updateingLayout.value=true
    graph.updateLayout(atlas.value.layout)
  }
  //改变插件
  const changePlugins=function(){
    graph.removePlugin(fisheye)
    graph.removePlugin(grid)
    fisheye = new G6.Fisheye({
      r: 200,
      showLabel: true,
    })
    
    if(atlas.value.set.ifgrid==true){
      grid = new G6.Grid()
      graph.addPlugin(grid)
    }
    if(atlas.value.set.iffisheye==true){
      graph.addPlugin(fisheye)
    }
  }
  const changeMode=function(){
    console.log(atlas.value.set.mode)
    if (atlas.value.set.mode=="浏览模式"){
      graph.setMode('default')
    } else if(atlas.value.set.mode=="节点编辑"){
      graph.setMode('NodeEdit')
    } else if(atlas.value.set.mode=="添加链接"){
      graph.setMode('EdgeEdit')
    }
  }
  const changeNodeType=function(){
    if (atlas.value.defaultNode.type=="rect"){
      atlas.value.defaultNode.size= [100, 25]
    } else if(atlas.value.defaultNode.type=="circle"){
      atlas.value.defaultNode.size= [25,25]
    }
    
    let data=graph.save()
    //设置所有节点样式
    for(let i = 0;i<data.nodes.length;i++){
      if(atlas.value.defaultNode.type=="rect"){
        console.log(store.app.data.nodes[i].fullName)
        data.nodes[i].label=store.app.data.nodes[i].fullName
      }else{
        //delete data.nodes[i].label
      }
      data.nodes[i].type=atlas.value.defaultNode.type
      data.nodes[i].size=atlas.value.defaultNode.size
    }
    graph.changeData(data)
  }
  const changeEdgeType=function(){
    let data = graph.save()
    for(let i = 0;i<data.edges.length;i++){
      data.edges[i].type=atlas.value.set.EdgeType
    }
    graph.changeData(data)
  }
  //改变节点标签
  const changeNodeLabel=function(){
    let data = graph.save()
    //data.nodes[store.data.set.nodeIndex].label=store.data.nodes[store.data.set.nodeIndex].title
    graph.changeData(data)
  }
  const changeEdgeLabel=function(){
    let data = graph.save()
    //data.edges[store.data.set.edgeIndex].label=store.data.edges[store.data.set.edgeIndex].label
    graph.changeData(data)
  }
  const changeComboLabel=function(){
    let data = graph.save()
    //console.log(data.edges[store.data.set.comboIndex])
    //data.combos[store.data.set.comboIndex].label=store.data.combos[store.data.set.comboIndex].title
    graph.changeData(data)
  }
  const addNode=function(){
    //store.addNode()
    InitGraph()
  }
  //删除节点
  const delNode=function(id:any){
    let data = graph.save()
    for(let i = 0;i<data.nodes.length;i++){
      //从数据上删除点
      //console.log(db.nodes[i].id,id)
      if(db.nodes[i].id==id){
        db.nodes.splice(i,1)
      }
      //图上删除节点
      if(data.nodes[i].id==id){
        data.nodes.splice(i,1)
      }
      //修改所有边的index
      data.nodes[i].index=i
    }
    //删除所有关联边
    let tEdgeDB=[] as any
    let tEdge=[] as any
    for(let i = 0;i<db.edges.length;i++){
      if(db.edges[i].source!=id&&db.edges[i].target!=id){
        tEdgeDB.push(db.edges[i])
        tEdge.push(db.edges[i])
      }
    }
    db.edges=tEdge
    data.edges=tEdge
    //更新图中边
    graph.changeData(data)
  }
  //删除边
  const delEdge=function(id:any){
    //从数据上删除点
    for(let i = 0;i<db.edges.length;i++){
      if(db.edges[i].id==id){
        db.edges.splice(i,1)
      }
    }
    //从图上删除
    let data = graph.save()
    data.edges.splice(id,1)
    //修改所有边的index
    for(let i = 0;i<data.edges.length;i++){
      data.edges[i].index=i
    }
    graph.changeData(data)
  }

  //创建组合
  const createCombo=function(){
    const nodes = graph.findAllByState('node', 'selected')
    const combos = graph.findAllByState('combo', 'selected')
    if(nodes.length+combos.length<2){
      store.app.notification="未选中两个以上节点"
      return
    }
    //组合ID
    let id=(new Date()).valueOf().toString()
    let idList=[] as any
    for(let i=0;i<nodes.length;i++){
      idList.push(nodes[i].getModel().id)
      //为节点赋予编组
      for(let j=0;j<store.app.data.nodes.length;j++){
        if(store.app.data.nodes[j].id==nodes[i].getModel().id){
          store.app.data.nodes[j].comboId=id
        }
      }
    }
    for(let i=0;i<combos.length;i++){
      idList.push(combos[i].getModel().id)
      //为组合赋予父组合
      for(let j=0;j<store.app.data.combos.length;j++){
        if(store.app.data.combos[j].id==combos[i].getModel().id){
          store.app.data.combos[j].parentId=id
        }
      }
    }
    //图上创建组合
    graph.createCombo({
      id: id,
      label:'默认标题',
      content:'',
      index:store.app.data.combos.length
    }, idList)
    //数据上记录组合数组
    store.app.data.combos.push({
      id:id,
      label:'默认标题',
      content:'',
      index:store.app.data.combos.length
    })
  }
  //删除组合
  const delCombo=function(){
    let data = graph.save()
    let combos=data.combos
    let nodes=data.nodes
    let edges=data.edges

    //获取comboID
    let id = store.app.data.combos[store.app.data.set.comboIndex].id
    //图上删除
    
    //将相关组合数据清除
    for(let i=0;i<combos.length;i++){
      if(combos[i].parentId==id){
        delete combos[i].parentId
        delete store.app.data.combos[i].parentId
      }
    }
    //将相关节点数据清除
    for(let i=0;i<nodes.length;i++){
      if(nodes[i].comboId==id){
        delete nodes[i].comboId
        delete store.app.data.nodes[i].comboId
      }
    }
    //将相关链接数据清除
    for(let i=0;i<edges.length;i++){
      if(edges[i].source==id||edges[i].target==id){
        edges.splice(i,1)
        //store.delLink(i)
      }
    }

    //更新所有边的index
    for(let i = 0;i<data.edges.length;i++){
      data.edges[i].index=i
    }

    data.combos.splice(store.app.data.set.comboIndex,1)
    store.app.data.combos.splice(store.app.data.set.comboIndex,1)
    graph.changeData(data)
    //重置所有组合的index
    for(let i = 0;i<data.combos.length;i++){
      data.combos[i].index=i
    }
    //重置comboIndex
    store.app.data.set.comboIndex=-1
    //理论上应修改所有节点的comboId，不修改也没有bug
  }
  //适应窗口
  const fitView =function(){
    graph.getEdges().forEach((edge:any) => {
      graph.clearItemStates(edge);
    })
    graph.getNodes().forEach((node:any) => {
      graph.clearItemStates(node);
    })
    graph.fitView(10)
    updateLabelStyle()
  }
  //搜索
  const search=function(){
    atlas.value.result=[]
    for(let i=0;i<db.nodes.length;i++){
      //判断标题是否符合
      let a=db.nodes[i].id.split(atlas.value.set.keyword).length-1
      //判断内容是否符合
      let b=0
      if(db.nodes[i].data.content!=undefined){
        b=db.nodes[i].data.content.split(atlas.value.set.keyword).length-1
      }
      if(a+b>0){
        atlas.value.result.push(db.nodes[i])
      }
    }
  }
  //聚焦到搜索结果
  const focusResult=function(){
    //查询所有节点
    let nodes = graph.getNodes()
    let edges = graph.getEdges()
    if(atlas.value.set.mode=="浏览模式"){
      //设置所有节点为弱化
      for(let i = 0;i<nodes.length;i++){
        graph.clearItemStates(nodes[i])
        graph.setItemState(nodes[i], 'inactive', true)

        nodes[i].getModel().label=""
        nodes[i].update(nodes[i]._cfg.model)
      }
      //设置所有边为弱化
      for(let i = 0;i<edges.length;i++){
        graph.clearItemStates(edges[i])
        graph.setItemState(edges[i], 'inactive', true)
      }
      
      //设置搜索到的节点为无状态
      for(let i = 0;i<nodes.length;i++){
        for(let j = 0;j<atlas.value.result.length;j++){
          if(nodes[i].getModel().data.fullName==atlas.value.result[j].data.fullName){
            graph.clearItemStates(nodes[i])
            nodes[i].getModel().label=nodes[i].getModel().data.fullName
            nodes[i].update(nodes[i]._cfg.model)
          }
        }
      }
    }
  }
  //聚焦到某个节点
  const clickNode= function(id:any,center:boolean){
    //使节点居中
    if(center==true){
      graph.focusItem(id, true, {
        easing: 'easeCubic',
        duration: 500,
      })
    }
    //查询节点
    const node = graph.findById(id)
    //查询所有节点
    let nodes = graph.getNodes()
    let edges = graph.getEdges()
    if(atlas.value.set.mode=="浏览模式"){
      //设置所有节点为弱化
      for(let i = 0;i<nodes.length;i++){
        graph.clearItemStates(nodes[i])
        graph.setItemState(nodes[i], 'inactive', true)

        nodes[i].getModel().label=""
        nodes[i].update(nodes[i]._cfg.model)
      }
      //设置所有边为弱化
      for(let i = 0;i<edges.length;i++){
        graph.clearItemStates(edges[i])
        graph.setItemState(edges[i], 'inactive', true)
      }
      //设置关联边为激活
      let redges=node.getEdges()
      for(let i = 0;i<redges.length;i++){
        graph.setItemState(redges[i], 'active', true)
      }
      //设置关联节点为激活
      let rnodes=node.getNeighbors()
      //console.log(rnodes)
      for(let i = 0;i<rnodes.length;i++){
        graph.setItemState(rnodes[i], 'active', true)
        //显示关联节点标签
        rnodes[i].getModel().label=rnodes[i].getModel().data.name
        rnodes[i].update(rnodes[i]._cfg.model)
      }
    }
    //设置节点突出
    graph.setItemState(id, 'active', true)
    //设置本节点的标签
    node.getModel().label=node.getModel().data.name
    node.update(node._cfg.model)
  }
  //聚焦到某个边
  const clickEdge= function(id:any,center:boolean){
    //使边居中
    if(center==true){
      graph.focusItem(id, true, {
        easing: 'easeCubic',
        duration: 500,
      })
    }
    //查询节点
    const edge = graph.findById(id)
    //查询所有节点
    let nodes = graph.getNodes()
    let edges = graph.getEdges()
    if(atlas.value.set.mode=="浏览模式"){
      //设置所有节点为弱化
      for(let i = 0;i<nodes.length;i++){
        graph.clearItemStates(nodes[i])
        graph.setItemState(nodes[i], 'inactive', true)

        nodes[i].getModel().label=""
        nodes[i].update(nodes[i]._cfg.model)
      }
      //设置所有边为弱化
      for(let i = 0;i<edges.length;i++){
        graph.clearItemStates(edges[i])
        graph.setItemState(edges[i], 'inactive', true)
      }
      //设置关联节点为激活
      let anodes=edge.getSource()
      graph.setItemState(anodes, 'active', true)
      anodes.getModel().label=anodes.getModel().data.fullName
      anodes.update(anodes._cfg.model)
      let bnodes=edge.getTarget()
      graph.setItemState(bnodes, 'active', true)
      bnodes.getModel().label=bnodes.getModel().data.fullName
      bnodes.update(bnodes._cfg.model)
    }
    //设置选中的边突出
    graph.setItemState(id, 'active', true)
    //查找序数并设置选择的节点
    for(let i = 0;i<edges.length;i++){
      if(edge._cfg.id==edges[i]._cfg.id){
        atlas.value.edgeIndex=i
      }
    }
  }
  //导出
  const exportImage=function(){
    graph.downloadImage()
  }
  //休眠一段时间
  function sleep(interval:any){
    return new Promise((resolve)=>    
      setTimeout(resolve, interval)
    )
  }
  //从json添加关系文件
  const addEdgesFromJSON=function(){
    let ipcRenderer = require('electron').ipcRenderer
    const path = ipcRenderer.sendSync('openFile',[])
    const fs = require("fs")
    let content=fs.readFileSync(path,'utf8')
    let edgesData=JSON.parse(content).edges
    //将读取到的边添加进入图中
    for(let i=0;i<edgesData.length;i++){
      let temp = {
        index:i,
        source:edgesData[i].source.toString(),
        target:edgesData[i].target.toString(),
      } as any
      db.edges.push(temp)
    }
    graph.data(db)
    graph.render() 
  }
  //从CSV添加关系文件
  const addEdgesFromCSV=function(){
    let ipcRenderer = require('electron').ipcRenderer
    const path = ipcRenderer.sendSync('openFile',[])
    const fs = require("fs")
    let content=fs.readFileSync(path,'utf8')
    //console.log(content)
    let edgesTemp=content.split("\r\n")
    edgesTemp.pop()
    let edgesData=[]
    for(let i=0;i<edgesTemp.length;i++){
      edgesData[i]=edgesTemp[i].split(",")
    }
    //将读取到的边添加进入图中
    for(let i=0;i<edgesData.length;i++){
      //console.log(edgesData[i])
      if(edgesData[i].length>=2){
        let temp = {
          index:db.edges.length,
          source:edgesData[i][0].toString(),
          target:edgesData[i][1].toString(),
        } as any
        db.edges.push(temp)
      }
    }
    graph.data(db)
    graph.render() 
  }
  
  //添加树形结构
  const addTree=function(){
    let ipcRenderer = require('electron').ipcRenderer
    ipcRenderer.send('openTreePath', 'openDirectory');
    ipcRenderer.on('selectedTreePath', function (e:any, result:any) {
      if(result.canceled==false){
        //设置树形关系的路径
        let treePath = result.filePaths[0]+"\\"
        const fs = require('fs')
        const path = require('path')
        //读取新树形数据
        let treeData = file.scanDeepData(treePath,atlas.value.deep,true) as any
        //console.log(treeData)
        //读取现有数据
        for(let i=0;i<treeData.edges.length;i++){
          let temp = {
            index:i,
            source:treeData.edges[i].source.toString(),
            target:treeData.edges[i].target.toString(),
            label:(atlas.value.set.EdgeLabel?treeData.edges[i].label:''),
          } as any
          db.edges.push(temp)
        }
        graph.data(db)
        graph.render()
      }
    })
  }
  //从矩阵数据添加
  const addDataFromMatrix=function(){
    let ipcRenderer = require('electron').ipcRenderer
    const path = ipcRenderer.sendSync('openFile',[])
    const fs = require("fs")
    let content=fs.readFileSync(path,'utf8')
    //console.log(content)
    transformDataFromMatrix(content,'#aaaaaa66',"add")
  }
  const transformDataFromMatrix=function(content:string,color:string,type:string){
    //解析为二维数组
    let rows = content.split("\r\n")
    rows.pop()
    let data=[] as any
    for(let i=0;i<rows.length;i++){
      data[i]=rows[i].split(",")
    }
    //console.log(data)
    //获取节点数据
    let a=[]
    let b=[]
    for(let i=3;i<data[0].length;i++){
      a.push({name:data[0][i],color:data[1][i],size:data[2][i]})
    }
    for(let j=3;j<data.length;j++){
      b.push({name:data[j][0],color:data[j][1],size:data[j][2]})
    }
    let nodes = a.concat(b)
    //console.log(nodes)
    //扫描现有的节点列表
    let nodesname=[]
    for(let k=0;k<db.nodes.length;k++){
      nodesname.push(db.nodes[k].label)
    }
    //添加节点
    for(let k=0;k<nodes.length;k++){
      //判断是否存在
      if(nodesname.indexOf(nodes[k].name) == -1){
        const temp = {} as any
        temp.id=nodes[k].name
        temp.data={}
        
        if(atlas.value.set.NodeLabel){
          if(atlas.value.set.NodeLabelRestrict){
            temp.label=fittingString(nodes[k].name,100,12) //限制标签长度
          }else{
            temp.label=nodes[k].name
          }
        }
        if(atlas.value.set.NodeColor=='彩色'){
          if (!temp.style){
            temp.style = {
              fill: 'rgba(200,200,200,0.2)',
              stroke: '#999999',
            }
          }
          if(nodes[k].color!=""){
            temp.style.fill = nodes[k].color
            temp.style.stroke = nodes[k].color
          }
        }
        temp.data=nodes[k]
        temp.data.fullName=nodes[k].name
        temp.size=[20,20]
        temp.size[0]=nodes[k].size
        temp.size[1]=nodes[k].size
        if(type=="add"){
          db.nodes.push(temp)
          nodesname.push(nodes[k].name) //通过添加现有节点列表，防止重复添加节点
        }
      }
    }
    //添加边
    for(let i=3;i<data.length;i++){
      for(let j=3;j<data[i].length;j++){
        if(data[i][j]!=0){
          let temp = {
            index:db.edges.length,
            source:data[i][0],
            target:data[0][j],
            style:{
              stroke:color
            }
          } as any
          //判断边是否存在
          let exist=false
          for(let k=0;k<db.edges.length;k++){
            if((temp.source==db.edges[k].source)&&(temp.target==db.edges[k].target)){
              exist=true
              if(type=="del"){
                db.edges.splice(k,1)
              }
            }
          }
          if(exist==false){
            if(type=="add"){
              db.edges.push(temp)
            }
          }
        }
      }
    }
    //渲染数据
    updateData()
  }
  //清除节点
  const clearNodes=function(){
    //清除边
    clearEdges()
    //清除数据
    db.nodes=[]
    //清除图
    let data=graph.save()
    data.nodes=[]
    //渲染数据
    graph.changeData(data)
    //重置序数
    atlas.value.nodeIndex=-1
  }
  //清除关系
  const clearEdges=function(){
    //清除数据
    db.edges=[]
    //清除图
    let data=graph.save()
    data.edges=[]
    //渲染数据
    graph.changeData(data)
  }
  //居中节点
  const centerNode=function(){
    const node = graph.findById(db.nodes[atlas.value.nodeIndex].id);
    //节点居中
    graph.focusItem(node, true, {
      easing: 'easeCubic',
      duration: 500,
    });
  }
  //展开节点
  const expandNode=async function(){
    //寻找节点的路径
    let fullPath = db.nodes[atlas.value.nodeIndex].data.fullPath
    try {
      //判断是否为文件夹
      if(!db.nodes[atlas.value.nodeIndex].data.isFolder) return
      let nodes = [] //节点
      let data = [] //数据
      let edges = [] //关系
      if(store.app.environment!="web"){
        nodes = await file.scanDeepFile(fullPath,1,false)
        data = await file.scanDeepData(fullPath,1,1) as any
        edges = data.edges
      }else{
        let address = store.app.path+db.nodes[atlas.value.nodeIndex].data.relativePath
        let str = await store.getCloudData(address,1,1) as any
        let t = JSON.parse(str)
        nodes = t.nodes
        edges = t.edges
      }
      //添加节点进入图中
      for(let i = 0;i<nodes.length;i++){
        //判断节点是否已经载入
        let exist = false
        for(let j = 0;j<db.nodes.length;j++){
          if(nodes[i].fullName==db.nodes[j].id){
            exist = true
          }
        }
        if(exist==false){
          //重构节点数据
          db.nodes.push(filterNode([nodes[i]])[0])
        }
      }
      //添加关系到图中
      console.log(edges.length)
      for(let i = 0;i<edges.length;i++){
        //判断边是否存在
        let exist = false
        for(let j = 0;j<db.edges.length;j++){
          if((edges[i].soure==db.edges[j].soure)&&(edges[i].target==db.edges[j].target)){
            exist = true
          }
        }
        if(exist == false){
          db.edges.push(filterEdge([edges[i]])[0])
        }
      }
      
      //console.log(db)
      //修改节点大小
      onNodeSizeMode()
      //更新布局
      updateData()
      //使节点居中
      const node = graph.findById(db.nodes[atlas.value.nodeIndex].id)
      setTimeout(function() {
        graph.focusItem(node, true, {
          easing: 'easeCubic',
          duration: 500,
        })
      }, 500)
      atlas.value.nodeIndex=-1
      //graph.render() 
      return true; // 文件存在
    } catch (err) {
      return false; // 文件不存在
    }
  }
  //打开节点
  const openNode=async function(){
    //判断是否存在文件实体
    if(db.nodes[atlas.value.nodeIndex].data.fullPath!=undefined){
      //判断是否已添加
      if(!store.addTab(db.nodes[atlas.value.nodeIndex].data)){
        if(store.app.environment!="web"){
          store.app.path=db.nodes[atlas.value.nodeIndex].data.fullPath
        }else{
          store.app.path=db.nodes[atlas.value.nodeIndex].data.fullPath
        }
      }
      if(store.app.objectView.indexOf("浏览")==-1){
        store.app.objectView[store.app.objectView.length]="浏览"
      }
      store.resize() //触发缩放
    }
  }
  //节点大小设置模式
  const onNodeSizeMode =function(){
    if(atlas.value.set.NodeSizeMode == "一致"){
      for(let i=0;i<db.nodes.length;i++){
        db.nodes[i].size[0]=25
        db.nodes[i].size[1]=25
      }
    }else if(atlas.value.set.NodeSizeMode == "配置信息"){
      for(let i=0;i<db.nodes.length;i++){
        if(db.nodes[i].data.attributes.节点大小!=undefined){
          db.nodes[i].size[0]=parseFloat(db.nodes[i].data.attributes.节点大小)
          db.nodes[i].size[1]=parseFloat(db.nodes[i].data.attributes.节点大小)
        }else{
          db.nodes[i].size[0]=25
          db.nodes[i].size[1]=25
        }
      }
    }
    updateData()
  }
  //分析
  const analyseData=function(){
    //初始化统计数据
    for (let node of db.nodes) {
      node.data.outDegree = 0;
      node.data.inDegree = 0;
    }
    //分析出度和入度
    for (let edge of db.edges) {
      db.nodes.forEach(node => {
        if (edge.source === node.label) node.data.outDegree++
        if (edge.target === node.label) node.data.inDegree++
      })
    }
  }
  //读取数据
  const loadData=async function(){
    if(store.app.environment!="web"){
      let ipcRenderer = require('electron').ipcRenderer
      const path = ipcRenderer.sendSync('openFile',[])
      const fs = require("fs")
      let data=JSON.parse(fs.readFileSync(path,'utf8'))
      db.nodes=JSON.parse(data.content).nodes as any
      db.edges=JSON.parse(data.content).edges as any
      db.combos=JSON.parse(data.content).combos as any
      atlas.value.layout=JSON.parse(data.layout)
      atlas.value.Option.layout=atlas.value.layout
      console.log(atlas.value.layout)
      updateLayout()
      //读取并渲染数据
      graph.read(db)
      //相当于如下代码
      //graph.data(db)
      //graph.render()
      graph.fitView()
    }else{
      const input = document.createElement('input')
      input.type = 'file'
      input.addEventListener('change', function(event:any) {
        const file = event.target.files[0]
        if (file) {
          const reader = new FileReader()

          reader.onload = function(event:any) {
            const str = event.target.result
            // 在这里处理文件内容
            let data=JSON.parse(str)
            db.nodes=JSON.parse(data.content).nodes as any
            db.edges=JSON.parse(data.content).edges as any
            db.combos=JSON.parse(data.content).combos as any
            atlas.value.layout=JSON.parse(data.layout)
            
            updateLayout()
            //读取并渲染数据
            graph.read(db)
            //相当于如下代码
            //graph.data(db)
            //graph.render()
            graph.fitView()
          }
          reader.readAsText(file) // 以文本形式读取文件
        }
      })
      input.click() // 触发文件选择对话框
    }
  }
  //保存数据
  const saveData=function(){
    //console.log(graph.save())
    let data={} as any
    data.layout = JSON.stringify(atlas.value.layout,null,2)
    data.content = JSON.stringify(graph.save(),null,2)
    const currentDate = new Date()
    const filename = "图谱_"+atlas.value.layout.type+"_"+currentDate.getMonth()+"."+currentDate.getDate()+"_"+currentDate.getHours()+"."+currentDate.getMinutes()+".tp"
    const element = document.createElement('a')
    element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(JSON.stringify(data)))
    element.setAttribute('download', filename)
    element.style.display = 'none'
    document.body.appendChild(element)
    element.click()
    document.body.removeChild(element)
  }
  //更新标签样式
  const updateLabelStyle = function(){
    let nodes = graph.getNodes()
    if(atlas.value.set.NodeLabel){
      for(let i = 0;i<nodes.length;i++){
        nodes[i]._cfg.model.label=nodes[i]._cfg.model.data.name
        nodes[i].update(nodes[i]._cfg.model)
      }
    }else{
      for(let i = 0;i<nodes.length;i++){
        nodes[i]._cfg.model.label=""
        nodes[i].update(nodes[i]._cfg.model)
      }
    }
  }
  //读取配置文件
  const changeConfig = function(index:any){
    //变更状态
    if(index!=null){
      atlas.value.config[index].state=!atlas.value.config[index].state
    }
    for(let i = 0;i<atlas.value.config.length;i++){
      if(atlas.value.config[i].state==true){
        //添加边
        if(atlas.value.config[i].type==".csv"){
          transformDataFromMatrix(atlas.value.config[i].content,atlas.value.config[i].color,"add")
        }
      }else if(atlas.value.config[i].state==false){
        //删除边
        if(atlas.value.config[i].type==".csv"){
          transformDataFromMatrix(atlas.value.config[i].content,atlas.value.config[i].color,"del")
        }
      }
    }
  }
  //更改节点数据
  const changeData = function(index:number,p:string,data:any){
    let attributes = file.getConfig(db.nodes[index].data.fullPath)
    attributes[p]=data
    let state = file.saveConfig(db.nodes[index].data.fullPath,attributes)
    if(state) store.app.notification="保存属性成功"
    if(p=="节点颜色"){
      //如果更改的是颜色
      if(atlas.value.set.NodeColor=='彩色'){
        if (!db.nodes[index].style) db.nodes[index].style = {}
        db.nodes[index].style.fill = data
        db.nodes[index].style.stroke = data
        const item = graph.findById(db.nodes[index].id)
        graph.updateItem(item,db.nodes[index])
      }
    }else if(p=="节点大小"){
      db.nodes[index].size = data
      const item = graph.findById(db.nodes[index].id)
      graph.updateItem(item,db.nodes[index])
    }
  }
  //为节点排序
  const sortNode=function(type:string){

  }
  //获取节点属性
  const getAttributes = function(){
    // 获取所有属性
    let allProps = [] as any
    store.app.data.nodes.forEach((obj: { attributes: any }) => {
      const props = Object.keys(obj.attributes)
      for(let i = 0;i<props.length;i++){
        if(!/^[A-Za-z]+$/.test(props[i])){
          let t = {
            name:props[i],
            state:0,
            color:'rgba(170, 170, 170, 0.4)'
          } as any
          allProps.push(t)
        }
      }
    })
    // 去除重复属性
    let result = allProps.filter((obj:any, index:any, self:any) => {
      // 检查当前对象是否在之前的对象中出现过
      return (
        index ===
        self.findIndex((o:any) => {
          return JSON.stringify(o) === JSON.stringify(obj)
        })
      )
    })
    atlas.value.attributes = result
  }
  //展开节点的属性
  const expandNodeAttribute=function(id:number,key:string,state:number){
    console.log(id,key,state)
    
  }
  //展开所有节点的某一类属性
  const expandAttribute=function(index:number,state:number){
    //参数为attributes参数中的属性序号，属性状态
    atlas.value.attributes[index].state=state
    let attribute = atlas.value.attributes[index].name //需要展开的属性
    if(state==1||state==-1){ //如果是创建属性节点
      //循环遍历节点，并根据属性创建新节点
      for(let i = 0;i<db.nodes.length;i++){
        //如果该节点有这个属性
        if(db.nodes[i].data!=undefined){
          if(db.nodes[i].data.attributes!=undefined){
            if(db.nodes[i].data.attributes[attribute]!=undefined){
              let items =[]
              //切分属性，根据;和；进行切分
              if(db.nodes[i].data.attributes[attribute] instanceof Date){
                items =[store.StampToDate(db.nodes[i].data.attributes[attribute])]
              }else{
                items = db.nodes[i].data.attributes[attribute].split(/[;；]/)
              }
              //遍历所有items
              for (const item of items) {
                //判断节点是否存在
                let nodeState=false //是否有重复边
                for (const node of db.nodes) {
                  if(node.id==item){
                    //添加边
                    nodeState=true
                  }
                }
                if(nodeState==false){
                  //添加节点
                  db.nodes.push({
                    id:item,
                    label:item,
                    style:{
                      fill:atlas.value.attributes[index].color,
                      stroke:atlas.value.attributes[index].color,
                    },
                    size:[10,10],
                    data:{
                      name:item,
                      type:attribute
                    }
                  })
                }
                //边数据
                let edgeData={
                  source:state==1?db.nodes[i].id:item,
                  target:state==1?item:db.nodes[i].id,
                  style:{
                    fill:atlas.value.attributes[index].color,
                    stroke:atlas.value.attributes[index].color,
                  },
                  type:attribute
                }
                let edgeState=false //是否有重复边
                for (const edge of db.edges) {
                  if(edge.source==edgeData.source&& edge.target==edgeData.target && edge.type==edgeData.type){
                    //添加边
                    edgeState=true
                  }
                }
                if(edgeState==false) db.edges.push(edgeData)
              }
            }
          }
        }
      }
    }else{
      //如果是删除行为
      //删除属性节点
      for(let i = 0;i<db.nodes.length;i++){
        if(db.nodes[i].data.type!=undefined){
          let filteredNodes = db.nodes.filter(item => item.data.type !== attribute)
          db.nodes=filteredNodes
        }
      }
      //删除属性边
      for(let i = 0;i<db.edges.length;i++){
        if(db.edges[i].type!=undefined){
          let filteredEdges = db.edges.filter(item => item.type !== attribute)
          db.edges=filteredEdges
        }
      }
    }
    updateData()
  }
  //重新缩放视图时的操作
  const resizeAtlas=async function(){
    if (graph == null || document.getElementById("mountNode")!.children.length < 1) {
      return;
    }
    if (graph.changeSize != undefined) {
      graph.changeSize(
        document.getElementById("mountNodeBG")!.offsetWidth,
        document.getElementById("mountNodeBG")!.offsetHeight - 26
      )
    }
  }
  //更换领域时，更新图谱
  watch(()=>store.app.path, (newValue, oldValue) => {
    if(atlas.value.watchPath==1){
      if(graph!=null) graph.destroy()
      document.getElementById("mountNode")!.innerHTML=""
      InitGraph()
    }
  })
  //监听标签样式
  watch(()=>atlas.value.set.NodeLabel, (newValue, oldValue) => {
    updateLabelStyle()
  })
  //保存数据
  const save = async function(e:any) {
    if(store.app.path=="") return
    if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
      e.preventDefault()
      //saveData()
    }
  }
  onMounted(() => {
    document.getElementById("mountNode")!.innerHTML=""
    atlas.value.Option.width = document.getElementById("mountNodeBG")!.offsetWidth
    atlas.value.Option.height = document.getElementById("mountNodeBG")!.offsetHeight-26
    //初始化图谱
    InitGraph()
    //添加监听事件
    window.addEventListener('resize', resizeAtlas)
    window.addEventListener('keydown', save)
    //若有配置，读取配置，否则使用默认配置
    if(localStorage.getItem('atlas')!=null){
      let temp=JSON.parse(localStorage.getItem('atlas')!)
      atlas.value=temp
      atlas.value.nodeIndex=-1
    }else{
      localStorage.setItem('atlas',JSON.stringify(atlas.value))
    }
  })
  onBeforeUnmount(() => {
    if(graph!=null) graph.destroy()
    window.removeEventListener('resize', resizeAtlas)
    window.removeEventListener('keydown', save)
    localStorage.setItem('atlas',JSON.stringify(atlas.value))
    //console.log(atlas)
  })
</script>

<template >
  <!--图谱视图-->
  <div class="ViewAtlas" id="mountNodeBG" :style="{borderBottom:store.app.domainView.length>1?'1px solid var(--borderColor)':''}">
    <!--节点编辑及预览界面-->
    <div class="edit" style="width:95px" v-show="atlas.nodeIndex!=-1" id="nodeMenu">
      <div v-if="atlas.nodeIndex!=-1&&db.nodes.length!=0" class="contextMenu">
        <ul>
          <li title="使节点居中" @click="centerNode();atlas.nodeIndex=-1">
            <i class="fa fa-dot-circle-o"></i> 居中节点
          </li>
          <li title="查看节点的连接" @click="clickNode(db.nodes[atlas.nodeIndex].id,false);atlas.nodeIndex=-1">
            <i class="fa fa-code-fork"></i>&nbsp; 查看连接
          </li>
          <li v-if="db.nodes[atlas.nodeIndex].data.isFolder&&atlas.showTree" title="展开节点" @click="expandNode()">
            <i class="fa fa-expand"></i> 展开节点
          </li>
          <!--开发中
          <li title="展开属性">
            <i class="fa fa-arrow-circle-o-right"></i> 展开属性
            <ul>
              <li v-for="key in Object.keys(db.nodes[atlas.nodeIndex].data.attributes)" :key="key" @click="expandNodeAttribute(atlas.nodeIndex,key,1)">
                {{key}}
              </li>
            </ul>
          </li>-->
          <li v-if="db.nodes[atlas.nodeIndex].data.fullPath!=undefined" title="查看节点信息" @click="openNode()">
            <i class="fa fa-file-text"></i> 查看内容
          </li>
          <li v-if="db.nodes[atlas.nodeIndex].data.fullPath!=undefined" title="并将图谱更新到该节点所在的路径" @click="store.app.path=db.nodes[atlas.nodeIndex].data.fullPath;atlas.nodeIndex=-1;if(atlas.watchPath==0){InitGraph()}">
            <i class="fa fa-crosshairs"></i> 聚焦图谱
          </li>
          <li v-if="store.app.environment!='web'&&db.nodes[atlas.nodeIndex].data.fullPath!=undefined" title="更改颜色">
            <div style="height:20px;display:flex;width: 100%;border: 1px solid var(--borderColor);margin:2px 0px">
              <div style="flex:1;background-color:#FFFFFF" @click="changeData(atlas.nodeIndex,'节点颜色','#FFFFFF')"></div>
              <div style="flex:1;background-color:#aaaaaa" @click="changeData(atlas.nodeIndex,'节点颜色','#aaaaaa')"></div>
              <div style="flex:1;background-color:#666666" @click="changeData(atlas.nodeIndex,'节点颜色','#666666')"></div>
              <div style="flex:1;background-color:#CC6666" @click="changeData(atlas.nodeIndex,'节点颜色','#CC6666')"></div>
              <div style="flex:1;background-color:#CC99CC" @click="changeData(atlas.nodeIndex,'节点颜色','#CC99CC')"></div>
              <div style="flex:1;background-color:#CC9966" @click="changeData(atlas.nodeIndex,'节点颜色','#CC9999')"></div>
              <div style="flex:1;background-color:#CCCC66" @click="changeData(atlas.nodeIndex,'节点颜色','#CCCC66')"></div>
              <div style="flex:1;background-color:#66CC66" @click="changeData(atlas.nodeIndex,'节点颜色','#66CC66')"></div>
              <div style="flex:1;background-color:#66CCCC" @click="changeData(atlas.nodeIndex,'节点颜色','#66CCCC')"></div>
              <div style="flex:1;background-color:#6699CC" @click="changeData(atlas.nodeIndex,'节点颜色','#6699CC')"></div>
              <el-color-picker v-model="db.nodes[atlas.nodeIndex].style.stroke" show-alpha @change="changeData(atlas.nodeIndex,'节点颜色',db.nodes[atlas.nodeIndex].style.stroke)"/>
            </div>
          </li>
          <li style="margin-bottom:5px">
            <input type="range" style="padding:5px;margin-top:-5px;width:calc(100% - 10px);" v-model="db.nodes[atlas.nodeIndex].data.size" :title="db.nodes[atlas.nodeIndex].data.size" @change="changeData(atlas.nodeIndex,'节点大小',db.nodes[atlas.nodeIndex].data.size)" min="1" max="50"/>
          </li>
        </ul>
      </div>
    </div>
    <!--工具界面-->
    <div class="menu">
        <ul style="width:calc(100%);height:25px">
          <li @click="loadData()" title="读取方案">
            <i class="fa fa-folder-open"></i>
          </li>
          <li @click="saveData()" title="保存方案">
            <i class="fa fa-save"></i>
          </li>
          <li @click="InitGraph()" title="刷新">
            <i class="fa fa-refresh"></i>
          </li>
          <li @click="fitView();" title="聚焦">
            <i class="fa fa-arrows-alt"></i>
          </li>
          <li @click="updateingLayout=true;store.pathBack();atlas.nodeIndex=-1;if(atlas.watchPath==0){InitGraph()}" title="向上一层">
            <i class="fa fa-arrow-up"></i>
          </li>
          <li @click="controlPanel=!controlPanel" :class="[controlPanel?'active':'']" title="设置">
            <i class="fa fa-cogs"></i>
          </li>
          <li style="width:calc(100% - 230px)">
            {{store.app.path==""?"根目录":store.app.path}}
          </li>
        </ul>
    </div>
    <div class="panel scoll" v-if="controlPanel" style="width:300px">
      <span title="设置" @click="controlPanelType='设置'" style="width:calc(20% - 12px);text-align:center;padding:5px;border:var(--borderColor) 1px solid" :style="{backgroundColor:controlPanelType=='设置'?'var(--menuColor)':''}">
        <i class="fa fa-cog"></i>
      </span>
      <span title="样式" @click="controlPanelType='样式'" style="width:calc(20% - 12px);text-align:center;padding:5px;border:var(--borderColor) 1px solid" :style="{backgroundColor:controlPanelType=='样式'?'var(--menuColor)':''}">
        <i class="fa fa-adjust"></i>
      </span>
      <span title="搜索" @click="controlPanelType='搜索'" style="width:calc(20% - 12px);text-align:center;padding:5px;border:var(--borderColor) 1px solid" :style="{backgroundColor:controlPanelType=='搜索'?'var(--menuColor)':''}">
        <i class="fa fa-search"></i>
      </span>
      <span @click="controlPanelType='点'" style="width:calc(20% - 12px);text-align:center;padding:5px;border:var(--borderColor) 1px solid" :style="{backgroundColor:controlPanelType=='点'?'var(--menuColor)':''}">
        <i class="fa fa-circle"></i>
        {{ db.nodes.length }}
      </span>
      <span @click="controlPanelType='边'" style="width:calc(20% - 12px);text-align:center;padding:5px;border:var(--borderColor) 1px solid" :style="{backgroundColor:controlPanelType=='边'?'var(--menuColor)':''}">
        <i class="fa fa-gg"></i>
        {{ db.edges.length }}
      </span>
      <!--<span @click="controlPanelType='组合'" style="width:calc(20% - 12px);text-align:center;padding:5px;border:var(--borderColor) 1px solid" :style="{backgroundColor:controlPanelType=='组合'?'var(--menuColor)':''}">组合：{{ db.combos.length }}</span>-->
      <div class="scoll" v-if="controlPanelType=='设置'">
      <table>
        <tr style="text-align: center;">
          <td rowspan="2"><i class="fa fa-bars"></i></td>
          <td rowspan="2" style="max-width:100px;text-overflow: ellipsis;">关系名称</td>
          <td colspan="2">状态</td>
          <td rowspan="2">颜色</td>
        </tr>
        <tr style="text-align: center;">
          <td title="依赖"><i class="fa fa-angle-down"></i></td>
          <td title="产出"><i class="fa fa-angle-up"></i></td>
        </tr>
        <tr style="text-align: center;">
          <td><i class="fa fa-usb"></i></td>
          <td>读取路径本体</td>
          <td colspan="2" v-if="atlas.showSelf==0" @click="atlas.showSelf=1;InitGraph()"><i class="fa fa-toggle-off" /></td>
          <td colspan="2" v-if="atlas.showSelf==1" @click="atlas.showSelf=0;InitGraph()"><i class="fa fa-toggle-on" /></td>
          <td></td>
        </tr>
        <tr style="text-align: center;">
          <td><i class="fa fa-usb"></i></td>
          <td>默认隶属关系</td>
          <td colspan="2" v-if="atlas.showTree==0" @click="atlas.showTree=1;InitGraph()"><i class="fa fa-toggle-off" /></td>
          <td colspan="2" v-if="atlas.showTree==1" @click="atlas.showTree=0;InitGraph()"><i class="fa fa-toggle-on" /></td>
          <td><el-color-picker v-model="atlas.set.EdgeColor" show-alpha/></td>
        </tr>
        <tr v-for="(item,index) in atlas.config" :key="index" style="text-align: center;">
          <td><i class="fa fa-file-excel-o"></i></td>
          <td style="max-width:100px;text-overflow: ellipsis;">{{item.name}}</td>
          <td colspan="2" @click="changeConfig(index)" v-if="item.state==false"><i class="fa fa-toggle-off" /></td>
          <td colspan="2" @click="changeConfig(index)" v-if="item.state==true"><i class="fa fa-toggle-on" /></td>
          <td><el-color-picker v-model="item.color" show-alpha/></td>
        </tr>
        <tr v-for="(item,index) in atlas.attributes" :key="index" style="text-align: center;">
          <td><i class="fa fa-file-text"></i></td>
          <td style="max-width:100px;text-overflow: ellipsis;" :title="item.name">{{item.name}}</td>
          <td @click="expandAttribute(index,-1)" v-if="item.state==0||item.state==1"><i class="fa fa-toggle-off" /></td>
          <td @click="expandAttribute(index,0)" v-if="item.state==-1"><i class="fa fa-toggle-on" /></td>
          <td @click="expandAttribute(index,1)" v-if="item.state==0||item.state==-1"><i class="fa fa-toggle-off" /></td>
          <td @click="expandAttribute(index,0)" v-if="item.state==1"><i class="fa fa-toggle-on" /></td>
          <td><el-color-picker v-model="item.color" show-alpha/></td>
        </tr>
      </table>
      <hr />
      <span class="label">隶属深度：</span>
      <select v-model="atlas.deep" style="width:calc(100% - 82px)" @change="InitGraph()">
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="5">5</option>
        <option value="6">6</option>
        <option value="7">7</option>
        <option value="8">8</option>
        <option value="9">9</option>
        <option value="10">10</option>
      </select>
      <span class="label">布局类型：</span>
      <select v-model="atlas.layout.type" @change="updateLayoutType()" style="width:calc(100% - 82px)">
        <option value="dagre">层次(dagre)</option>
        <option value="forceAtlas2">力导向图(forceAtlas2)</option>
        <option value="force">力导向图(force)</option>
        <option value="gForce">力导向图(gForce)</option>
        <option value="comboForce">组合力导向图(comboForce)</option>
        <option value="mds">高维数据降维(mds)</option>
        <option value="radial">辐射形(radial)</option>
        <option value="grid">网格(grid)</option>
        <option value="circular">环形(circular)</option>
        <option value="concentric">同心圆(concentric)</option>
        <option value="fruchterman">fruchterman</option>
      </select>
      <span class="label">节点大小：</span>
      <select v-model="atlas.set.NodeSizeMode" @change="onNodeSizeMode()" style="width:calc(100% - 82px)">
        <option value="一致">一致</option>
        <option value="配置信息">配置信息</option>
      </select>
        <!--force参数-->
        <div v-if="atlas.layout.type=='force'">
          <div>
            <span class="label">边长:</span>
            <input :title="atlas.layout.linkDistance" type="range" min="1" max="500" step="1" v-model.number="atlas.layout.linkDistance" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">节点力:</span>
            <input :title="atlas.layout.nodeStrength" type="range" min="-5" max="200" step="1" v-model.number="atlas.layout.nodeStrength" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">边力:</span>
            <input :title="atlas.layout.edgeStrength" type="range" min="0.01" max="5" step="0.01" v-model.number="atlas.layout.edgeStrength" @change="updateLayout"/>
          </div>
        </div>

        <!--gForce参数-->
        <div v-if="atlas.layout.type=='gForce'">
          <div>
            <span class="label">迭代:</span>
            <input :title="atlas.layout.maxIteration" type="range" min="500" max="3000" step="1" v-model.number="atlas.layout.maxIteration" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">初始边长:</span>
            <input :title="atlas.layout.linkDistance" type="range" min="1" max="1000" step="1" v-model.number="atlas.layout.linkDistance" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">节点斥力:</span>
            <input :title="atlas.layout.nodeStrength" type="range" min="300" max="2000" step="1" v-model.number="atlas.layout.nodeStrength" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">边的拉力:</span>
            <input :title="atlas.layout.edgeStrength" type="range" min="50" max="400" step="0.01" v-model.number="atlas.layout.edgeStrength" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">显卡计算：</span>
            <select v-model="atlas.layout.gpuEnabled" @change="updateLayout()" style="width:calc(100% - 82px)">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
        </div>

        <!--ComboForce参数-->
        <div v-if="atlas.layout.type=='comboForce'">
          <div>
            <span class="label">初始边长:</span>
            <input :title="atlas.layout.linkDistance" type="range" min="1" max="100" step="1" v-model.number="atlas.layout.linkDistance" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">节点斥力:</span>
            <input :title="atlas.layout.nodeStrength" type="range" min="3" max="300" step="1" v-model.number="atlas.layout.nodeStrength" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">边的拉力:</span>
            <input :title="atlas.layout.edgeStrength" type="range" min="0.02" max="2" step="0.01" v-model.number="atlas.layout.edgeStrength" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">迭代数:</span>
            <input :title="atlas.layout.maxIteration" type="range" min="100" max="1000" step="1" v-model.number="atlas.layout.maxIteration" @change="updateLayout"/>
          </div>
        </div>

        <!--forceAtlas2参数-->
        <div v-if="atlas.layout.type=='forceAtlas2'">
          <div>
            <span class="label">斥力系数:</span>
            <input :title="atlas.layout.kr" type="range" min="1" max="150" step="0.1" v-model.number="atlas.layout.kr" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">重力系数:</span>
            <input :title="atlas.layout.kg" type="range" min="1" max="50" step="0.1" v-model.number="atlas.layout.kg" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">移动速度:</span>
            <input :title="atlas.layout.ks" type="range" min="1" max="20" step="0.1" v-model.number="atlas.layout.ks" @change="updateLayout"/>
          </div>
        </div>

        <!--mds参数-->
        <div v-if="atlas.layout.type=='mds'">
          <div>
            <span class="label">长度:</span>
            <input :title="atlas.layout.linkDistance" type="range" min="20" max="500" step="1" v-model.number="atlas.layout.linkDistance" @change="updateLayout"/>
          </div>
        </div>

        <!--circular参数-->
        <div v-if="atlas.layout.type=='circular'">
          <div>
            <span class="label">半径:</span>
            <input :title="atlas.layout.radius" type="range" min="20" max="500" step="1" v-model.number="atlas.layout.radius" @change="updateLayout"/>
          </div>
        </div>

        <!--radial参数-->
        <div v-if="atlas.layout.type=='radial'">
          <div>
            <span class="label">边长:</span>
            <input :title="atlas.layout.linkDistance" type="range" min="10" max="500" step="1" v-model.number="atlas.layout.linkDistance" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">半径:</span>
            <input :title="atlas.layout.unitRadius" type="range" min="50" max="500" step="1" v-model.number="atlas.layout.unitRadius" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">节点:</span>
            <input :title="atlas.layout.nodeSize" type="range" min="50" max="200" step="1" v-model.number="atlas.layout.nodeSize" @change="updateLayout"/>
          </div>
        </div>

        <!--concentric参数-->
        <div v-if="atlas.layout.type=='concentric'">
          <div>
            <span class="label">节点:</span>
            <input :title="atlas.layout.nodeSize" type="range" min="30" max="100" step="1" v-model.number="atlas.layout.nodeSize" @change="updateLayout"/>
          </div>
        </div>

        <!--Dagre参数-->
        <div v-if="atlas.layout.type=='dagre'">
          <div>
            <span class="label">宽度:</span>
            <input :title="atlas.layout.nodesep" type="range" min="-40" max="40" step="1" v-model.number="atlas.layout.nodesep" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">高度:</span>
            <input :title="atlas.layout.ranksep" type="range" min="-20" max="40" step="1" v-model.number="atlas.layout.ranksep" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">布局方向：</span>
            <select v-model="atlas.layout.rankdir" @change="updateLayoutType()" style="width:calc(100% - 80px)">
              <option value="TB">从上至下</option>
              <option value="BT">从下至上</option>
              <option value="LR">从左至右</option>
              <option value="RL">从右至左</option>
            </select>
          </div>
          <div>
            <span class="label">对齐方式：</span>
            <select v-model="atlas.layout.align" @change="updateLayoutType()" style="width:calc(100% - 80px)">
              <option value="">中间对齐</option>
              <option value="UL">对齐到左上角</option>
              <option value="UR">对齐到右上角</option>
              <option value="DL">对齐到左下角</option>
              <option value="DR">对齐到右下角</option>
            </select>
          </div>
        </div>

        <!--fruchterman参数-->
        <div v-if="atlas.layout.type=='fruchterman'">
          <div>
            <span class="label">重力：</span>
            <input :title="atlas.layout.gravity" type="range" min="1" max="40" step="0.1" v-model.number="atlas.layout.gravity" @change="updateLayout"/>
          </div>
          <div>
            <span class="label">速度：</span>
            <input :title="atlas.layout.speed" style="" type="range" min="0.3" max="3" step="0.1" v-model.number="atlas.layout.speed" @change="updateLayout"/>
          </div>
        </div>
        <hr />
        <span class="label">操作模式：</span>
        <select v-model="atlas.set.mode" style="width:calc(100% - 82px)"  @change="changeMode()">
          <option value="浏览模式">浏览模式</option>
          <option value="节点编辑">节点编辑</option>
          <option value="添加链接">添加链接</option>
        </select>
        <span class="label">双击操作：</span>
        <select v-model="store.app.clickToOpen" style="width:calc(100% - 82px)">
          <option value="智能操作">智能操作</option>
          <option value="本级，无分页">本级，无分页</option>
          <option value="本级，有分页">本级，有分页</option>
          <option value="上级，无分页">上级，无分页</option>
          <option value="上级，有分页">上级，有分页</option>
        </select>
        <span class="label">路径变化：</span>
        <select v-model="atlas.watchPath" style="width:calc(100% - 82px)">
          <option value="1">监听</option>
          <option value="0">不监听</option>
        </select>
        <!--<span >聚合重名：</span>
        <select v-model="AggregateDuplicates" style="width:calc(100% - 82px)" @change="InitGraph()">
          <option value="1">是</option>
          <option value="0">否</option>
        </select>-->
        <hr />
        <button title="导出图形" style="width:25%" @click="exportImage()">
          <i class="fa fa-picture-o"></i>
        </button>
        <button title="组合选中的节点" style="width:25%" @click="createCombo()">
          <i class="fa fa-object-group"></i>
        </button>
        <button title="清除节点" style="width:25%" @click="clearNodes()">
          <i class="fa fa-trash"></i>&nbsp;
          <i class="fa fa-circle"></i>
        </button>
        <button title="清除关系" style="width:25%" @click="clearEdges()">
          <i class="fa fa-trash"></i>&nbsp;
          <i class="fa fa-gg"></i>
        </button>
        <button title="从矩阵CSV文件中导入数据，第一列为节点名称，第二列为颜色，第三列为大小" style="width:25%" @click="addDataFromMatrix()">
          <i class="fa fa-table"></i>
        </button>
        <button title="从文件夹中导入包含关系" style="width:25%" @click="addTree()">
          <i class="fa fa-sitemap"></i>
        </button>
        <button title="从JSON文件中导入关系" style="width:25%" @click="addEdgesFromJSON()">
          <i class="fa fa-link"></i>
        </button>
        <button title="从CSV文件中导入关系" style="width:25%" @click="addEdgesFromCSV()">
          <i class="fa fa-link"></i>
        </button>
        <button title="分析数据，目前可以分析节点的出度和入度" style="width:25%" @click="analyseData()">
          <i class="fa fa-calculator"></i>
        </button>
        <button title="重置数据" style="width:25%" @click="atlas.set.EdgeColor='#aaaaaa66'">
          <i class="fa fa-wrench"></i>
        </button>
      </div>
      <div style="height:calc(100% - 180px);overflow-y:auto;overflow-x: hidden;" class="scoll" v-if="controlPanelType=='样式'">
        <span style="color:var(--fontActiveColor)">节点：</span>
        <span>标签：</span>
        <span v-if="atlas.set.NodeLabel==false" @click="atlas.set.NodeLabel=true"><i class="fa fa-toggle-off" /></span>
        <span v-if="atlas.set.NodeLabel==true" @click="atlas.set.NodeLabel=false"><i class="fa fa-toggle-on" /></span>
        <span>长度：</span>
        <span v-if="atlas.set.NodeLabelRestrict==false" @click="atlas.set.NodeLabelRestrict=true;InitGraph()"><i class="fa fa-toggle-off" /></span>
        <span v-if="atlas.set.NodeLabelRestrict==true" @click="atlas.set.NodeLabelRestrict=false;InitGraph()"><i class="fa fa-toggle-on" /></span>
        <br/>
        <span>节点类型：</span>
        <span :style="{color:(atlas.defaultNode.type=='rect')?'var(--fontActiveColor)':''}" @click="atlas.defaultNode.type='rect';changeNodeType()">矩形</span>&nbsp;
        <span :style="{color:(atlas.defaultNode.type=='circle')?'var(--fontActiveColor)':''}" @click="atlas.defaultNode.type='circle';changeNodeType()">圆形</span>
        <br />

        <span>节点颜色：</span>
        <span :style="{color:(atlas.set.NodeColor=='单色')?'var(--fontActiveColor)':''}" @click="atlas.set.NodeColor='单色';InitGraph()">单色</span>&nbsp;
        <span :style="{color:(atlas.set.NodeColor=='彩色')?'var(--fontActiveColor)':''}" @click="atlas.set.NodeColor='彩色';InitGraph()">彩色</span>
        <br/>

        <span>锚点位置：</span>
        <span :style="{color:(atlas.defaultNode.anchorPoints.toString()==[[0, 0.5],[1, 0.5],[0.5, 0],[0.5, 1]].toString())?'var(--fontActiveColor)':''}" @click="atlas.defaultNode.anchorPoints=[[0, 0.5],[1, 0.5],[0.5, 0],[0.5, 1]];InitGraph()">四周</span>&nbsp;
        <span :style="{color:(atlas.defaultNode.anchorPoints.toString()==[[0.5, 0.5]].toString())?'var(--fontActiveColor)':''}" @click="atlas.defaultNode.anchorPoints=[[0.5, 0.5]];InitGraph()">中间</span>
        <br />

        <span>标签位置：</span>
        <span :style="{color:(atlas.defaultNode.labelCfg.position=='center')?'var(--fontActiveColor)':''}" @click="atlas.defaultNode.labelCfg.position='center';InitGraph()">中间</span>&nbsp;
        <span :style="{color:(atlas.defaultNode.labelCfg.position=='bottom')?'var(--fontActiveColor)':''}" @click="atlas.defaultNode.labelCfg.position='bottom';InitGraph()">底部</span>&nbsp;
        <span :style="{color:(atlas.defaultNode.labelCfg.position=='right')?'var(--fontActiveColor)':''}" @click="atlas.defaultNode.labelCfg.position='right';InitGraph()">右侧</span>
        <hr/>
        <span style="color:var(--fontActiveColor)">边：</span>
        <span>显示：</span>
        <span v-if="atlas.set.EdgeShow==false" @click="atlas.set.EdgeShow=true;InitGraph()"><i class="fa fa-toggle-off" /></span>
        <span v-if="atlas.set.EdgeShow==true" @click="atlas.set.EdgeShow=false;InitGraph()"><i class="fa fa-toggle-on" /></span>
        &nbsp;&nbsp;
        <span>标签：</span>
        <span v-if="atlas.set.EdgeLabel==false" @click="atlas.set.EdgeLabel=true;InitGraph()"><i class="fa fa-toggle-off" /></span>
        <span v-if="atlas.set.EdgeLabel==true" @click="atlas.set.EdgeLabel=false;InitGraph()"><i class="fa fa-toggle-on" /></span>
        <br/>
        <span>类型：</span>
        <select v-model="atlas.set.EdgeType" style="width:75%" @change="changeEdgeType()">
          <option label="直线" value="" />
          <option label="曲线" value="arc" />
          <option label="折线" value="polyline" />
          <option label="水平赛贝尔" value="cubic-horizontal" />
          <option label="垂直赛贝尔" value="cubic-vertical" />
          <option label="动态边" value="circle-running" />
        </select>
        <hr/>
        <span style="color:var(--fontActiveColor)">组合：</span>
        <span>显示：</span>
        <span v-if="atlas.set.ComboShow==false" @click="atlas.set.ComboShow=true;InitGraph()"><i class="fa fa-toggle-off" /></span>
        <span v-if="atlas.set.ComboShow==true" @click="atlas.set.ComboShow=false;InitGraph()"><i class="fa fa-toggle-on" /></span>
        &nbsp;&nbsp;
        <span>标签：</span>
        <span v-if="atlas.set.ComboLabel==false" @click="atlas.set.ComboLabel=true;InitGraph()"><i class="fa fa-toggle-off" /></span>
        <span v-if="atlas.set.ComboLabel==true" @click="atlas.set.ComboLabel=false;InitGraph()"><i class="fa fa-toggle-on" /></span>
        <hr/>
        <span style="color:var(--fontActiveColor)">背景：</span>
        <span>网格：</span>
        <span v-if="atlas.set.ifgrid==false" @click="atlas.set.ifgrid=true;changePlugins()"><i class="fa fa-toggle-off" /></span>
        <span v-if="atlas.set.ifgrid==true" @click="atlas.set.ifgrid=false;changePlugins()"><i class="fa fa-toggle-on" /></span>
        &nbsp;&nbsp;
        <span>鱼眼：</span>
        <span v-if="atlas.set.iffisheye==false" @click="atlas.set.iffisheye=true;changePlugins()"><i class="fa fa-toggle-off" /></span>
        <span v-if="atlas.set.iffisheye==true" @click="atlas.set.iffisheye=false;changePlugins()"><i class="fa fa-toggle-on" /></span>
        <hr/>
        <el-color-picker v-model="atlas.set.EdgeColor" show-alpha @change="InitGraph()"/> 边颜色<br/>
        <el-color-picker v-model="atlas.defaultNode.labelCfg.style.fill" show-alpha @change="InitGraph()"/> 节点标签颜色<br/>
        <el-color-picker v-model="atlas.defaultNode.style.fill" show-alpha @change="InitGraph()"/> 节点背景颜色<br/>
        <el-color-picker v-model="atlas.set.EdgeLabelColor" show-alpha @change="InitGraph()"/> 边标签颜色<br/>
        <el-color-picker v-model="atlas.set.ComboLabelColor" show-alpha @change="InitGraph()"/> 组合标签颜色<br/>
        <el-color-picker v-model="atlas.set.ComboBackgroundColor" show-alpha @change="InitGraph()"/> 组合背景颜色<br/>
      </div>
      <div style="height:calc(100% - 40px);overflow-y:auto;overflow-x: hidden;" class="scoll" v-if="controlPanelType=='搜索'">
        <div style="display: flex;">
          <input v-model="atlas.set.keyword" style="border-radius: 0px;" @change="search" placeholder="请输入关键字"/>
          <button style="height:36px;border-radius: 0px;text-align: center;" @click="search">
            <i class="fa fa-search"></i>
          </button>
          <button style="height:36px;border-radius: 0px;text-align: center;" @click="focusResult">
            <i class="fa fa-star-o"></i>
          </button>
        </div>
        <div class= "searchResult scoll">
          <ul>
            <li v-for="(item,index) in atlas.result" :key="index" @click="clickNode(item.id,true)">
              {{item.id}}
            </li>
          </ul>
        </div>
      </div>
      <div style="height:calc(100% - 40px);overflow-y:auto;overflow-x: auto;" class="scoll" v-if="controlPanelType=='点'">
        <table>
          <tr>
            <th @click="sortNode('color')"></th>
            <th @click="sortNode('id')">名称</th>
            <th>出</th>
            <th>入</th>
            <th><i class="fa fa-trash"></i></th>
          </tr>
          <tr v-for="item in db.nodes">
            <td :style="{backgroundColor:item.data.color}"></td>
            <td style="max-width: 100px;" :title="item.label" @click="clickNode(item.id,true)">{{ item.id }}</td>
            <td style="text-align: center;">{{ item.data.outDegree }}</td>
            <td style="text-align: center;">{{ item.data.inDegree }}</td>
            <td style="text-align: center;" @click="delNode(item.id)"><i class="fa fa-trash"></i></td>
          </tr>
        </table>
      </div>
      <div style="height:calc(100% - 40px);overflow-y:auto;overflow-x: hidden;" class="scoll" v-if="controlPanelType=='边'">
        <table>
          <tr>
            <th></th>
            <th>起点</th>
            <th>终点</th>
            <th><i class="fa fa-trash"></i></th>
          </tr>
          <tr v-for="item in db.edges">
            <td @click="clickEdge(item.id,true)" style="text-align: center;">{{ item.index }}</td>
            <td @click="clickEdge(item.id,true)" style="max-width:80px" :title="item.source">{{ item.source }}</td>
            <td @click="clickEdge(item.id,true)" style="max-width:80px" :title="item.target">{{ item.target }}</td>
            <td @click="delEdge(item.id)" style="text-align: center"><i class="fa fa-trash"></i></td>
          </tr>
        </table>
      </div>
    </div>
    <!--布局更新动画-->
    <div class="updateingLayout" v-if="updateingLayout">
      <i class="fa fa-spinner fa-spin fa-1x"></i>
    </div>
    <!--图谱-->
    <div id="mountNode"></div>
    
  </div>
</template>

<style scoped>
  .ViewAtlas{
    position: relative;
    width: 100%;
    height: 100%;
    min-width:120px;
    overflow: hidden;
    color:var(--fontColor);
    background-color:var(--backgroundColor);
    flex:4;
  }
  .updateingLayout{
    position: absolute;
    /*display: flex;
    justify-content: center;
    align-items: center;
    height:calc(100% - 67px);*/
    bottom: 0px;
    height:calc(30px);
    width:100%;
    text-align: center;
    color:var(--fontColor);
  }
  .svg{
    display: inline;
    z-index:-10;
    height:calc(100% - 4px);
    width:calc(100%);
    color:var(--menuColor);
  }
  
  .prep{
    position: absolute;
    padding: 5px;
    padding-top: 0px;
    height:calc(100% - 50px);
    width:calc(100% - 10px);
    overflow-y: auto;
    overflow-x: hidden;
  }
  .navs{
    display: flex;
    width:100%;
    text-align: center;
    height:25px;
    user-select: none;
    cursor: pointer;
    transition: 0.5s;
  }
  .nav{
    display: inline-block;
    width:100%;
    border-radius: 5px;
    line-height:25px;
  }
  .content{
    padding: 5px;
    overflow-y: auto;
    border-top:1px solid var(--borderColor) ;
    background-color: var(--backgroundColor);
    border-radius: 0px 0px 10px 10px;
  }
  .searchResult{
    height:calc(100% - 45px);
    overflow-y:auto;
    overflow-x: hidden;
  }
  .searchResult ul{
    margin: 0px;
    margin-left: 10px;
    padding: 0px;
  }
  .searchResult ul li{
    list-style-type: none;
    margin: 0px;
    padding: 0px;
    cursor:pointer;
    white-space:nowrap;
  }

  input{
    border-radius:5px;
    outline: none;
    border: 1px solid var(--borderColor);
    font-size:15px;
    text-align: center;
  }
  
  button{
    margin: 0px;
    margin-bottom: 5px;
    padding: 0px;
    padding-left: 10px;
    padding-right: 10px;
    height:30px;
  }
  hr{
    border: 1px solid var(--borderColor);
  }
  textarea{
    position: relative;
    width:calc(100% - 22px);
    height:calc(100% - 10px);
    max-height:100%;
    background-color: var(--backgroundColor);
    color:var(--fontColor);
    border:1px solid var(--borderColor);
    border-radius: 5px;
    resize: none;
    font-size: 16px;
    line-height: 24px;
    outline: none;
    padding-left: 10px;
    padding-right: 10px;
  }
  select{
    margin-top: 3px;
    margin-bottom: 3px;
  }
  .label{
    width:76px
  }
  input[type="range"]{
    position: relative;
    right:0px;
    width:calc(100% - 90px);
    height:5px;
    border-radius: 5px;
    margin:5px 0px
  }
  table{
    border-radius: 5px;
  }
  table td{
    height:20px;
    white-space: nowrap;
    overflow:hidden;
    user-select: text;
    padding: 3px;
  }
  table th{
    position: sticky;
    top: 0;
    background-color: var(--backgroundColor); /* 设置背景颜色 */
    z-index: 999; /* 设置z-index属性以确保它在最顶层 */
  }
  .menu{
    position: relative;
    width:100%;
    height:25px;
    border-bottom:1px solid var(--borderColor);
    user-select: none;
  }
  .menu ul {
    position:absolute;
    margin: 0px;
    padding:0px;
    padding-top:0px;
    z-index:99;
    display:block;
    white-space:nowrap;
  }
  
  .menu ul li {
    position: relative;
    height:19px;
    cursor:pointer;
    line-height:18px;
    white-space:nowrap;
    padding:3px;
    padding-right:10px;
    padding-left: 10px;
    width:fit-content;
    display:inline-block;
    text-align: left;
  }
  .menu li:hover {
    background-color: var(--menuActiveColor);
  }
  .edit{
    position:fixed;
    background-color: var(--backgroundColor);
    border: 1px solid var(--borderColor);
    z-index: 999;
    user-select:none;
  }
  .contextMenu{
    background-color: var(--menuColor);height:fit-content;
    user-select: none;
    font-size:14px
  }
  .contextMenu ul {
    position:relative;
    margin: 0px;
    padding:0px;
    padding-top:0px;
    z-index:99;
    display:block;
  }
  .contextMenu ul li {
    position: relative;
    height:19px;
    line-height:18px;
    white-space:nowrap;
    padding:0px;
    padding-right:5px;
    padding-left: 5px;
    width:calc(100% - 10px);
    display:inline-block;
    text-align: left;
    background-color: var(--menuColor);
  }
  .contextMenu ul li:hover{
    background-color:var(--menuActiveColor);
  }
  .contextMenu ul li ul{
    display: none;
    position: absolute;
    left: 100%;
    top: 0;
    border:1px solid var(--borderColor)
  }
  .contextMenu li:hover ul {
    display: block;
  }
  .contextMenu ul li ul li{
    display: block;
  }
  .active{
    background-color: var(--menuActiveColor);
  }
  .panel{
    position: relative;
    float:right;
    padding: 5px;
    width:210px;
    height:calc(100% - 26px);
    background-color: var(--backgroundColor);
    border-left:1px solid var(--borderColor) ;
    overflow-y: auto;
    z-index: 10;
    opacity: 0.75;
    user-select: none;
  }
  #mountNode{
    position: absolute;
  }
</style>
