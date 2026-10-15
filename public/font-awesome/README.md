# public/font-awesome — 图标字体（Font Awesome 5.15.4）

## 这里是什么

| 文件 | 说明 |
|---|---|
| `css/all.min.css` | Font Awesome 5.15.4 主样式表（含图标定义与 `@font-face`） |
| `css/v4-shims.min.css` | **FA4 名字的别名表 —— 必须加载，不能漏**（见下） |
| `css/font-awesome-animation.*` | 另一个独立小库（动画 `faa-*`），**与 FA 版本无关**，没有 `font-family` 声明，所以不动它 |
| `webfonts/fa-solid-900.*` | 实心字形（`font-weight: 900`） |
| `webfonts/fa-regular-400.*` | 线框字形（`font-weight: 400`） |
| `webfonts/fa-brands-400.*` | 品牌图标 |

被 `index.html` 引用（**三行，顺序有讲究**）：

```html
<link rel="stylesheet" href="/font-awesome/css/all.min.css">
<link rel="stylesheet" href="/font-awesome/css/v4-shims.min.css">   <!-- 不能漏 -->
<link rel="stylesheet" href="/font-awesome/css/font-awesome-animation.min.css">
```

## 为什么 v4-shims 不能漏

升级前全应用用了 **91 个 FA4 特有的名字**（`fa-refresh`、`fa-file-text-o`、`fa-circle-o`、
`fa-check-square-o` …），合计 **849 处**。这些名字在 FA5 的原生图标表里**不存在**，
只有 `v4-shims` 提供别名。**漏了它就等于这 849 处直接渲染成空白，且不报错。**

## FA5 与 FA4 的两个关键差别（改代码前必读）

1. **字族名变了**：`FontAwesome` → `Font Awesome 5 Free`（品牌图标是 `Font Awesome 5 Brands`）。
   任何自己写 `font-family` 再配字形码的地方都必须改，否则图标不显示。
2. **线框/实心用「字重」区分，而不是不同码位**：
   FA4 里 `-o`（线框）与实心是**两个码位**；FA5 把它们**合并成同一个码位**，
   靠 `font-weight: 400`（线框）/ `900`（实心）区分。
   所以「只把码位换成新的」不够 —— 原来用线框的地方不补 `font-weight: 400` 会**静默变成实心**。

## 升级 / 核对用的两个工具

```bash
# 图标名审计：宿主用到的名字在目标 FA 里是否都存在（读 index.html 里实际链接的 css）
node scripts/audit-fa5-icons.mjs --fa5 <fa5的css目录>
node scripts/audit-fa5-icons.mjs --fa5 <dir> --root "D:\Project\2 Knowledge Plugin"   # 审计插件

# 裸字形码映射：把 \u{fXXX} / content:'\fXXX' 映射到 FA5，并标出需要 font-weight:400 的
node scripts/fa-glyph-map.mjs --fa5 <fa5的css目录>
```

两个脚本都是**只读**的，`break > 0` / 有码位无法映射时退出码为 1，可直接挂 CI。
完整的迁移方案与审计表见
[字体图标升级FA-4.7到5-迁移方案（含审计表）](../../docs/plan/字体图标升级FA-4.7到5-迁移方案（含审计表）.md)。

## 换版本时怎么做

1. 取得目标版本的 `css/all.min.css`、`css/v4-shims.min.css`、`webfonts/*`；
2. 替换本目录对应文件（**`all.min.css` 必须放在 `css/` 下** —— 它内部用 `../webfonts/` 引用字体，
   放错层会让字体全部加载失败）；
3. 跑上面两个脚本，确认「图标名 `break = 0`」「字形码 0 个需人工确认」；
4. **改 `src/` 里所有自己写 `font-family` 的地方**（`grep -rn "font-family:.*FontAwesome" src` 应为 0 命中）；
5. 走一遍方案 §六 的逐页观感验收 —— 那一步自动化替代不了。

## 附：`office-host.ts` 也用了这份字体

`electron/main/office-host.ts` 会把 `webfonts/fa-solid-900.woff2` 读成 base64 内联进
Office 编辑器渲染层（那里自带图标全是内联 SVG，AI 入口的图标位需要一份图标字体）。
它引用的字形码是 `\f0d0`（fa-magic），在 FA4 与 FA5 里**码位相同**；
换版本时只需确认字体文件路径与文件仍存在。
