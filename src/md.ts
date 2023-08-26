import MarkdownIt from 'markdown-it'
import katex from 'markdown-it-katex'
import tocAndAnchor from 'markdown-it-toc-and-anchor'
import mark from 'markdown-it-mark'
import hljs from 'highlight.js'
import 'markdown-it-katex/node_modules/katex/dist/katex.min.css'
import {usestore} from './store'
const store=usestore()
export default {
  md : new MarkdownIt({
    html: true,
    linkify: true,
    highlight: function (str:any, lang:any) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return '<pre class="hljs"><code>' +
            hljs.highlight(str,{language: lang, ignoreIllegals: true }).value +
            '</code></pre>';
        } catch (__) {}
      }
      return '<pre class="hljs"><code>' + this.utils.escapeHtml(str) + '</code></pre>';
    },
    replaceLink: function (link:any, env:any) {
      const Expression=/http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/;
      const objExp=new RegExp(Expression);
      if(objExp.test(link)==true){
        return link
      }else{
        if(store.app.files.length>0){
          return "file://"+store.app.storePath+store.app.files[store.app.fileIndex].parentPath+"//" + link
        }
      }
    }
  }).use(require('markdown-it-replace-link'))
  .use(katex, { throwOnError: false, errorColor: '#CC0000' }) 
  .use(tocAndAnchor, {
    anchorLink:false,
  })
  .use(mark),
}

