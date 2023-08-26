//const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin')
module.exports = {
    publicPath:'/',
    pluginOptions: {
        electronBuilder: {
          nodeIntegration: true,
          externals:[
            "vue",
            "element-plus",
          ],
          nodeModulesPath: [
            '../../node_modules',
            './node_modules'
          ]
        }
    },
    /**
    win: {
      icon: './public/icon.ico' //打包windows版本的logo
    },
    */
    /**
    configureWebpack: {
        plugins: [
          new MonacoWebpackPlugin()
        ]
      }
       */
}