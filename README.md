# AI-KM

This software provides a new set of tools for personal and organizational knowledge management and analysis.

## 1 Technical Solution

The platform is developed using Electron, with the frontend developed using Vue. Important modules used include Pania, Anvt-G6, Dhtmlx-Gantt, Markdown-it, Leaflet, pdfjs-dist, js-yaml, Monaco Editor, etc. This software has the following features:

* Local data storage: Data is saved locally, ensuring good security.
* Multiple views: Supported views include tree view, folder view, kanban, knowledge graph, Gantt chart, calendar, map, browser, editor, mind map, PPT, etc.
* AI assistant: It can perform local analysis and interaction with the knowledge base by calling the Wenda large language model API.
* TTS: It can interact with the AI assistant or read articles or novels by calling the GPT-SoVITE.
* Distributed deployment: It can achieve distributed access and deployment in a local area network. Collaborative file sharing after opening data sharing on the client will be more convenient.

The software interface is as shown in the figure below:

![UI](./ui.jpg)

## 2 Software Development Method

The development environment requires setting NODE_ENV = "development" in electron/main.js

```shell
npm install
npm run electron:serve
```

## 3 Software Packaging Method

When packaging, set NODE_ENV = "other" in electron/main.js

```shell
npm run electron:build
```

## 4 Deployment of the Server

### 4.1 Access to AI
Please use the integration package in [Wenda](https://github.com/wenda-LLM/wenda), unzip the integration package, open the AI service, and fill in the address in the AI module.

> This function requires a minimum of 6GB of VRAM on the server side.

### 4.2 Access to TTS
Please use the integration package in [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS), unzip the integration package, open the TTS service, and fill in the address in the AI module or article view.

> This function requires a minimum of 2GB of VRAM on the server side.

The link to the server integration package is: https://pan.baidu.com/s/1p3E77BJDBdqzmHGPlXDzyQ
The extraction code for the integration package is: 8b9d

## 5 Instructions for Use

### 5.1 Basic Usage

#### 5.1.1 Set Repository or Open MD File

* Click on the icon in the top left corner (File | Open | Repository) to select the address for knowledge repository management.
* Click on the icon in the top left corner (File | Open | File) to select and open an MD file.

#### 5.1.2 Create New File

* Click on the icon in the top left corner (New | Folder) to create a folder with a specified name in the current folder.
* Click on the icon in the top left corner (New | File) to create an MD file with a specified name in the current folder, which is the main format used in this software.
* Click on the icon in the top left corner (New | Whiteboard) to create a WB file with a specified name in the current folder, which is a whiteboard file.

#### 5.1.3 Select Theme

* Click on the icon in the top left corner (Theme | Light) to switch to a light theme.
* Click on the icon in the top left corner (Theme | Dark) to switch to a dark theme.
* You can also click on the settings button on the left to adjust specific parameters of the theme.

#### 5.1.4 Other Basic Operations

* Click on the icon in the top left corner (Other | Close All) to close all tabs.
* Click on the icon in the top left corner (Other | Keep Current) to close all tabs except the currently open one.
* Click on the icon in the top left corner (Other | Always on Top) to keep the software always on top.
* Click on the icon in the top left corner (Other | Show Desktop) to minimize the software and show the desktop.
* Click on the icon in the top left corner (Exit) to exit the software.

#### 5.1.5 Quick View Selection

At the top left, you can quickly select domain views and object views.

* In domain views, you can choose from views such as kanban, knowledge graph, Gantt chart, monthly, yearly map, table, browser, etc.
* In object views, you can choose from views like browse, edit, mind map, PPT, etc.

### 5.2 File Tree Browser

This feature can only be used after opening or creating a repository and allows management in a tree view format.

* In the file tree, users can double-click on a file to open the corresponding tab. The software supports opening MD, PDF, HTML, JS, CSS, TS, PY, JSON, JPG, JPEG, PNG, WebP, MP4, WMV, AVI, MP3, M4A, WB file types; other file types will be opened using the computer's default software.
* Within the file tree, users can perform operations like open, open with an external application, open the corresponding folder, copy, paste, etc.

### 5.3 Accessing Data from Other Nodes

This feature provides distributed access capability, allowing users to add other computers' IPs to access shared folders.

* Click on the settings button to add the IP, name, and key of other computers, allowing you to add that node to frequently accessed nodes.
* Click on the sync icon next to the node you want to access, enabling you to access the shared folder on the corresponding client. This operation requires the client to be open and sharing enabled.

### 5.4 Multi-View Selection Module

In this module, users can choose the type of view to use, including:

* Domain views such as kanban, knowledge graph, Gantt chart, monthly, yearly map, table, etc.
* Object views such as browse, edit, mind map, PPT, etc.

Additionally, users can open a small window view and browse the required views in a small window.

### 5.5 AI Assistant Module

In this module, users can use the AI assistant for Q&A or specifically for MD or PDF files.

* The AI assistant provides basic functions like normal conversation, summarization, guidance, testing, explanation, rewriting, continuation, translation, word games, etc.
* Users can freely add required functions by specifying the role AI plays, the scene it is in, and the commands needed.
* The AI assistant provides functions like related files, internet search, TTS with customizable voice settings, and NLP for compressing and searching based on natural language in associated data.

> To use this module, you need to first use the integration package in [Wenda](https://github.com/wenda-LLM/wenda), open the AI server, and then set the corresponding server IP in the module's settings.

> This module also supports TTS functionality, requiring configuration of the corresponding TTS service IP and voice settings to use.

### 5.6 File Sharing Module

In this module, you can select a folder to share and click "Open Share" to share the folder within the local area network. Other computers can access this shared folder by opening the client or web, setting the IP of the computer they want to access.

When this module is not activated, the sharing mode will not be enabled, allowing for local knowledge management to enhance data security.

### 5.7 Settings Module

In this module, you can configure the following:

* Software language, providing options for both Chinese and English interfaces.
* Knowledge base location in the software.
* Software theme, allowing for detailed configuration within this interface.
* PPT dimensions.
* Other interface configurations.
* Other software operations like closing tabs, initializing, opening the command line, clearing the command line.

License: CC BY-NC (Non-commercial use only)