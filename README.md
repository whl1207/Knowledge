# Distributed Multi-View Intelligent Knowledge Management Platform

This platform provides a new set of tools for knowledge management and analysis for individuals and organizations, utilizing distributed deployment, multi-view interaction, and intelligent access to knowledge bases.

## Technical Solution

The platform is developed using Electron, with Vue as the front-end framework. Important modules used include Pania, Anvt-G6, dhtmlx-gantt, markdown-it, Leaflet, pdfjs-dist, monaco-editor and js-yaml.

## Technical Features

* Data is stored locally on the platform, ensuring good data security.
* Supported views on the platform include file management, kanban boards, relationship graph, Gantt chart, calendar, map, browsing, editing, mind maps, and presentations.
* By utilizing the interface of the Wenda language model, the platform enables local analysis and interaction with the knowledge base.
* The platform facilitates distributed access and deployment within a local area network, making data collaboration more convenient after sharing and opening it up.

## Usage Instructions

First, run the following command to install the necessary dependencies:

```
npm install
```

Next, you can start the software in development mode by running the following command:

```
npm run electron:serve
```
attention:electron/main.js NODE_ENV = "development"

If you want to package the software, you can use the following command:

```
npm run electron:build
```
attention:electron/main.js NODE_ENV = "other"

By following these steps, you will be able to install the required dependencies, launch the software in development mode, and package it for distribution or deployment. Please make sure you have Node.js and npm installed before running these commands.

## Connect to AI
Integrate the wenda package from https://github.com/wenda-LLM/wenda. Then open the AI service and enter the access address in the AI module.

## license: CC BY-NC

# 分布式多视图智能化知识管理平台

该平台通过分布式部署特性、多视图交互方案、智能化调用知识库，为个人和组织的知识管理和分析提供了一套新的工具。

## 技术方案

该平台使用electron开发，前端使用vue进行开发，使用的重要模块包括pania、anvt-G6、dhtmlx-gantt、markdown-it、leaflet、pdfjs-dist、js-yaml、monaco-editor等。

## 技术特点

* 该平台的数据保存在本地，数据安全性可以得到良好保证。
* 该平台支持的视图包括：文件管理、看板、关系图图谱、甘特图、日历、地图、浏览、编辑、思维导图、演示等。
* 该平台通过调用wenda大语言模型的接口，实现了知识库的本地分析和交互。
* 该平台能够实现局域网中的分布式访问和分部署部署，开放共享后数据协同更加更方便。

## 使用方法

```shell
npm install //安装相关依赖
npm run electron:serve //实现开发模式
npm run electron:build //实现软件打包
```
注意：开发环境需要设置electron/main.js中的NODE_ENV = "development"
注意：编译环境需要设置electron/main.js中的NODE_ENV = "other"

## 接入ai
请使用wenda（https://github.com/wenda-LLM/wenda）中的整合包，然后打开AI服务，在AI模块中填入接入地址即可。

## license: CC BY-NC(禁止商用)