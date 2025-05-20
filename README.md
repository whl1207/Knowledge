# AI-KM Intelligent Knowledge Management Platform

## Overview
AI-KM (Artificial Intelligence Knowledge Management) is a next-generation knowledge management platform that integrates cutting-edge AI technologies. Leveraging large language models and knowledge graph technologies, it helps individuals and organizations achieve efficient knowledge organization, in-depth analysis, and intelligent application.

## Core Value
- **Intelligent Knowledge Processing**: Automatically parses, queries, and associates knowledge content
- **Multi-dimensional Visualization**: Provides 6 view modes to present knowledge relationships
- **Open Model Integration**: Supports seamless switching between mainstream open-source large language models via Ollama
- **Enterprise-grade Security**: All data processing is performed locally

## Key Features

### 1. Core Technical Architecture
- **Multi-model Integration Engine**
  - Supports mainstream large language models deployed via the Ollama framework
  - Base models: Deepseek-R1, qwen3, LLaMA3.3, QWQ
  - Embedding models: nomic-embed-text, bge-m3, mxbai-embed-large
  - Multimodal models: Gemma3, Mistral-Small 3.1

- **Enhanced Retrieval System**
  - RAG (Retrieval-Augmented Generation) architecture
  - Supports knowledge base preprocessing (default segmentation by 2 line breaks)
  - Supports similarity calculations for various embedding models
  - Supports hidden information inference in knowledge bases (default: deducing potential user queries) and knowledge fragment keyword editing
  - Supports custom retrieval thresholds (can set knowledge base retrieval thresholds based on cosine similarity, quantity, characters, etc.)
  - Explainable analysis and debugging of retrieval results, displaying similarity information for each knowledge fragment
  - Supports cosine similarity calculation and MDS dimensionality reduction-based similarity calculation

- **Visual Workflow Engine**
  - Drag-and-drop AI processing pipeline construction
  - Includes 3+ pre-built node templates
  - Supports workflow import/export

- **Markdown Document Editing**
  - Deep Markdown parsing and editing
  - Document structure analysis (heading hierarchy recognition)
  - Code block processing

- **Multi-view Knowledge Display Module**

| View Type       | Core Features                          | Use Cases                          |
|----------------|---------------------------------------|-----------------------------------|
| Knowledge Graph | 3D force-directed graph layout<br>Dynamic relationship discovery | Knowledge discovery<br>Concept mapping |
| Gantt Chart    | Timeline management<br>Progress tracking | Project management<br>Learning plans |
| Mind Map       | Free node editing<br>Topic focusing    | Brainstorming<br>Content creation |
| Calendar View  | Schedule association<br>Daily knowledge cards | Personal management<br>Memory reinforcement |
| Geographic View | Geotagging<br>Spatial analysis        | Regional studies<br>Field research |
| Presentation Mode | Focus tracking<br>Animated transitions | Knowledge sharing<br>Teaching & training |

- **Multi-platform Packaging & Deployment**
  - Electron-based packaging for Windows, Linux, macOS, and other platform clients

## Installation & Deployment

### System Requirements
- OS: Windows 10+/macOS 12+/Linux (Ubuntu 20.04+)
- Hardware:
  - Minimum: 8GB RAM, 4-core CPU, 10GB storage
  - Recommended: 16GB+ RAM, dedicated GPU, 50GB+ storage

### Development Environment Setup
```shell
# Install dependencies
npm install
# Run in development mode
npm run dev
# Build Windows client
npm run build
# Generate installation package 
```


# AI-KM 智能知识管理平台

## 概述
AI-KM（Artificial Intelligence Knowledge Management）是一个集成了前沿AI技术的下一代知识管理平台，通过大语言模型和知识图谱技术，帮助个人和组织实现知识的高效组织、深度分析和智能应用。

## 核心价值
- **智能知识处理**：自动解析、查询和关联知识内容
- **多维度可视化**：提供6种视图模式呈现知识关系
- **开放模型集成**：可以通过ollama支持主流开源大语言模型自由切换
- **企业级安全**：所有数据处理均在本地完成

## 主要功能

### 1. 核心技术架构
- **多模型集成引擎**
  - 支持 Ollama 框架部署的主流大语言模型
  - 基础模型：Deepseek-R1、qwen3、LLaMA3.3、QWQ
  - 嵌入模型：nomic-embed-text、bge-m3、mxbai-embed-large
  - 多模态模型：Gemma3、Mistral-Small 3.1

- **增强检索系统**
  - RAG（检索增强生成）架构
  - 支持知识库的预处理（默认按照2个换行符进行切片）
  - 支持各类嵌入模型的相似度计算
  - 支持知识库的隐藏信息推理（默认为反推用户可能提出的问题）和知识片段关键词编辑
  - 支持自定义检索阈值（可以支持余弦相似度、数量、字符等各类方式设定知识库检索域值）
  - 检索结果可解释性分析和调试，能在各知识片段中显示相似度信息。
  - 支持余弦相似度计算和基于MDS降维的相似度计算。

- **可视化工作流引擎**
  - 拖拽式AI处理流程构建
  - 预置3+处理节点模板
  - 支持工作流导入导出

- **markdown文档编辑**
  - Markdown深度解析和编辑
  - 文档结构分析（标题层级识别）
  - 代码块处理

- **多视图知识展示模块**

| 视图类型 | 核心功能 | 适用场景 |
|---------|--------|---------|
| 知识图谱 | 3D力导向图布局<br>动态关系发现 | 知识发现<br>概念梳理 |
| 甘特图 | 时间线管理<br>进度追踪 | 项目管理<br>学习计划 |
| 思维导图 | 自由节点编辑<br>主题聚焦 | 头脑风暴<br>内容创作 |
| 日历视图 | 日程关联<br>每日知识卡片 | 个人管理<br>记忆强化 |
| 地理视图 | 地理标记<br>空间分析 | 区域研究<br>田野调查 |
| 演示模式 | 焦点追踪<br>动画过渡 | 知识展示<br>教学培训 |

- **多平台打包部署**
  - 基于electron可打包维windows、linux、mac os等平台的客户端软件

## 安装与部署

### 系统要求
- 操作系统：Windows 10+/macOS 12+/Linux（Ubuntu 20.04+）
- 硬件配置：
  - 最低：8GB RAM，4核CPU，10GB存储
  - 推荐：16GB+ RAM，独立GPU，50GB+存储

### 开发环境配置
```shell
# 安装依赖
npm install
# 开发模式运行
npm run dev
# 构建Windows客户端
npm run build
# 生成安装包
```