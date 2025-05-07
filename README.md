# AI-KM Intelligent Knowledge Management Platform  

## Overview  
AI-KM (Artificial Intelligence Knowledge Management) is a next-generation knowledge management platform that integrates cutting-edge AI technologies. Leveraging large language models and knowledge graph technologies, it helps individuals and organizations efficiently organize, deeply analyze, and intelligently apply knowledge.  

## Core Value
- **Intelligent Knowledge Processing**: Automatically parses, categorizes, and associates knowledge content  
- **Multi-Dimensional Visualization**: Provides 6 view modes to display knowledge relationships  
- **Open Model Integration**: Supports seamless switching between mainstream open-source large language models  
- **Enterprise-Grade Security**: All data processing is performed locally  

## Key Features  

### 1. Core Technical Architecture  
- **Multi-Model Integration Engine**  
  - Supports mainstream large language models deployed via the Ollama framework  
  - Base models: Deepseek-R1, qwen3, LLaMA3.3, QWQ  
  - Embedding models: nomic-embed-text, bge-m3  
  - Multimodal models: Gemma3, Mistral-Small 3.1  
  - Model performance monitoring panel (response time, token consumption, etc.)  

- **Enhanced Retrieval System**  
  - RAG (Retrieval-Augmented Generation) architecture  
  - Hybrid retrieval strategy (semantic + keyword)  
  - Supports customizable retrieval thresholds (default: CS ≥ 0.7 for strong relevance)  
  - Retrieval result interpretability analysis  

- **Visual Workflow Engine**  
  - Drag-and-drop AI processing pipeline construction  
  - Pre-built templates with 3+ processing nodes  
  - Workflow import/export  

### 2. Intelligent Knowledge Processing  
- **Content Parsing**  
  - Deep Markdown parsing (supports GFM extended syntax)  
  - Document structure analysis (heading hierarchy recognition)  
  - Special handling for code blocks (30+ language support)  

- **Knowledge Vectorization**  
  - Dynamic chunking strategy (sliding window algorithm)  
  - Multi-dimensional metadata extraction  
  - Incremental update mechanism  

- **Knowledge Association**  
  - Automatically generates related questions (3-5 per knowledge fragment)  
  - Cross-document reference detection  
  - Similar content merging suggestions  

- **Optimization Tools**  
  - Retrieval effectiveness debugging console  
  - Vector space visualization  
  - Relevance feedback learning  

### 3. Multi-View Collaboration System  

| View Type       | Core Features                              | Use Cases                          |  
|-----------------|-------------------------------------------|------------------------------------|  
| Knowledge Graph | 3D force-directed graph layout<br>Dynamic relationship discovery | Knowledge discovery<br>Concept organization |  
| Gantt Chart     | Timeline management<br>Progress tracking  | Project management<br>Learning plans |  
| Mind Map        | Free node editing<br>Topic focus          | Brainstorming<br>Content creation  |  
| Calendar View   | Schedule association<br>Daily knowledge cards | Personal management<br>Memory reinforcement |  
| Geographic View | Geotagging<br>Spatial analysis           | Regional research<br>Field studies |  
| Presentation Mode | Focus tracking<br>Animated transitions   | Knowledge presentation<br>Teaching and training |  

## Installation and Deployment  

### System Requirements  
- Operating System: Windows 10+/macOS 12+/Linux (Ubuntu 20.04+)  
- Hardware Configuration:  
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
# Generate installer  
```


# AI-KM 智能知识管理平台

## 概述
AI-KM（Artificial Intelligence Knowledge Management）是一个集成了前沿AI技术的下一代知识管理平台，通过大语言模型和知识图谱技术，帮助个人和组织实现知识的高效组织、深度分析和智能应用。

## 核心价值
- **智能知识处理**：自动解析、分类和关联知识内容
- **多维度可视化**：提供6种视图模式呈现知识关系
- **开放模型集成**：支持主流开源大语言模型自由切换
- **企业级安全**：所有数据处理均在本地完成

## 主要功能

### 1. 核心技术架构
- **多模型集成引擎**
  - 支持 Ollama 框架部署的主流大语言模型
  - 基础模型：Deepseek-R1、qwen3、LLaMA3.3、QWQ
  - 嵌入模型：nomic-embed-text、bge-m3
  - 多模态模型：Gemma3、Mistral-Small 3.1
  - 模型性能监控面板（响应时间、token消耗等）

- **增强检索系统**
  - RAG（检索增强生成）架构
  - 混合检索策略（语义+关键词）
  - 支持自定义检索阈值（默认CS≥0.7为强相关）
  - 检索结果可解释性分析

- **可视化工作流引擎**
  - 拖拽式AI处理流程构建
  - 预置3+处理节点模板
  - 工作流导入导出

### 2. 智能知识处理
- **内容解析**
  - Markdown深度解析（支持GFM扩展语法）
  - 文档结构分析（标题层级识别）
  - 代码块特殊处理（30+语言支持）

- **知识向量化**
  - 动态分块策略（滑动窗口算法）
  - 多维度元数据提取
  - 增量更新机制

- **知识关联**
  - 自动生成关联问题（每个知识片段3-5个）
  - 跨文档引用检测
  - 相似内容合并建议

- **优化工具**
  - 检索效果调试台
  - 向量空间可视化
  - 相关性反馈学习

### 3. 多视图协作系统
| 视图类型 | 核心功能 | 适用场景 |
|---------|--------|---------|
| 知识图谱 | 3D力导向图布局<br>动态关系发现 | 知识发现<br>概念梳理 |
| 甘特图 | 时间线管理<br>进度追踪 | 项目管理<br>学习计划 |
| 思维导图 | 自由节点编辑<br>主题聚焦 | 头脑风暴<br>内容创作 |
| 日历视图 | 日程关联<br>每日知识卡片 | 个人管理<br>记忆强化 |
| 地理视图 | 地理标记<br>空间分析 | 区域研究<br>田野调查 |
| 演示模式 | 焦点追踪<br>动画过渡 | 知识展示<br>教学培训 |

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
