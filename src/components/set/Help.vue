<template>
  <div class="help-container">
    <!-- 顶部标签导航 -->
    <div class="help-top-tabs">
      <button
        v-for="section in sections"
        :key="section.id"
        class="top-tab"
        :class="{ active: activeSection === section.id }"
        @click="activeSection = section.id"
      >
        <span class="top-tab-icon"><i class="fa" :class="section.icon"></i></span>
        <span class="top-tab-label">{{ t(`sections.${section.id}.title`) }}</span>
      </button>
    </div>

    <!-- 主要内容区 -->
    <div class="help-main">
      <!-- 快速上手指南 -->
        <section id="quick-start" class="help-section" v-show="activeSection === 'quick-start'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-rocket"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.quick-start.title') }}</h2>
              <p class="section-desc">{{ t('sections.quick-start.subtitle') }}</p>
            </div>
          </div>

          <div class="overview-card">
            <div class="overview-head">
              <i class="fa fa-rocket"></i>
              <p v-html="t('quickStart.overview')"></p>
            </div>
            <div class="overview-tags">
              <span class="ov-tag" v-for="(tag, i) in t('quickStart.tags')" :key="i">
                <i class="fa fa-check-circle-o"></i>{{ tag }}
              </span>
            </div>
          </div>

          <div class="quick-steps">
            <div class="quick-step-row">
              <div class="quick-step">
                <div class="quick-step-head">
                  <span class="step-icon">1️⃣</span>
                  <h4>{{ t('quickStart.step1.title') }}</h4>
                </div>
                <ul>
                    <li v-for="(item, index) in t('quickStart.step1.items')" :key="index" v-html="item"></li>
                  </ul>
              </div>
              
              <div class="quick-step">
                <div class="quick-step-head">
                  <span class="step-icon">2️⃣</span>
                  <h4>{{ t('quickStart.step2.title') }}</h4>
                </div>
                <ul>
                    <li v-for="(item, index) in t('quickStart.step2.items')" :key="index" v-html="item"></li>
                  </ul>
              </div>
            </div>
            
            <div class="quick-step-row">
              <div class="quick-step">
                <div class="quick-step-head">
                  <span class="step-icon">3️⃣</span>
                  <h4>{{ t('quickStart.step3.title') }}</h4>
                </div>
                <ul>
                    <li v-for="(item, index) in t('quickStart.step3.items')" :key="index" v-html="item"></li>
                  </ul>
              </div>
              
              <div class="quick-step">
                <div class="quick-step-head">
                  <span class="step-icon">4️⃣</span>
                  <h4>{{ t('quickStart.step4.title') }}</h4>
                </div>
                <ul>
                    <li v-for="(item, index) in t('quickStart.step4.items')" :key="index" v-html="item"></li>
                  </ul>
              </div>
            </div>

            <div class="quick-step-row">
              <div class="quick-step">
                <div class="quick-step-head">
                  <span class="step-icon">5️⃣</span>
                  <h4>{{ t('quickStart.step5.title') }}</h4>
                </div>
                <ul>
                    <li v-for="(item, index) in t('quickStart.step5.items')" :key="index" v-html="item"></li>
                  </ul>
              </div>
              
              <div class="quick-step">
                <div class="quick-step-head">
                  <span class="step-icon">6️⃣</span>
                  <h4>{{ t('quickStart.step6.title') }}</h4>
                </div>
                <ul>
                    <li v-for="(item, index) in t('quickStart.step6.items')" :key="index" v-html="item"></li>
                  </ul>
              </div>
            </div>
          </div>

          <!-- 常见问题（原独立页签并入「快速开始」） -->
          <div class="content-card">
            <h3>{{ t('quickStart.faq.title') }}</h3>
            <div class="guide-step" v-for="(item, i) in faqItems" :key="'faq-' + i">
              <span class="guide-number">Q</span>
              <div class="guide-content">
                <strong v-html="item.q"></strong>
                <p v-html="item.a"></p>
              </div>
            </div>
          </div>
        </section>

        <!-- 概念介绍 -->
        <section id="concepts" class="help-section" v-show="activeSection === 'concepts'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-lightbulb-o"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.concepts.title') }}</h2>
              <p class="section-desc">{{ t('sections.concepts.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <!-- 工作流文件（.flow.yml） -->

            <div class="content-card">
              <h3>{{ t('concepts.overview.title') }}</h3>
              <p v-html="t('concepts.overview.desc')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('concepts.list.title') }}</h3>
              <div class="nodes-grid">
                <div class="node-item" v-for="c in conceptItems" :key="c.id">
                  <div class="node-icon">{{ c.icon }}</div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`concepts.items.${c.key}.name`) }}</div>
                    <div class="node-desc" v-html="t(`concepts.items.${c.key}.desc`)"></div>
                  </div>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('concepts.more.title') }}</h3>
              <p v-html="t('concepts.more.desc')"></p>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('concepts.more.items')" :key="i" v-html="item"></li>
              </ul>
            </div>
          </div>
        </section>

        <!-- 智能对话系统 -->
        <section id="ai-chat" class="help-section" v-show="activeSection === 'ai-chat'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-comment"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.ai-chat.title') }}</h2>
              <p class="section-desc">{{ t('sections.ai-chat.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <h3>{{ t('aiChat.schemes.title') }}</h3>
              <div class="nodes-grid">
                <div class="node-item" v-for="scheme in aiChatSchemes" :key="scheme.id">
                  <div class="node-icon">{{ scheme.icon }}</div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`aiChat.schemes.${scheme.key}.name`) }}</div>
                    <div class="node-desc" v-html="t(`aiChat.schemes.${scheme.key}.desc`)"></div>
                  </div>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('aiChat.tasks.title') }}</h3>
              <div class="guide-step" v-for="scheme in aiChatSchemes" :key="'task-' + scheme.id">
                <span class="guide-number">{{ scheme.icon }}</span>
                <div class="guide-content">
                  <strong>{{ t(`aiChat.schemes.${scheme.key}.name`) }}</strong>
                  <ul class="open-mode-list">
                    <li v-for="(item, i) in t(`aiChat.tasks.${scheme.key}.items`)" :key="i" v-html="item"></li>
                  </ul>
                </div>
              </div>
            </div>

            <!-- 关键概念（大模型 / 智能体 / 工具 / MCP / 技能 …）已移到「概念介绍」页签 -->
            <!-- 集群模式（智能对话的一种模式）：只做简介，细节见下文模式说明 -->
            <div class="content-card">
              <h3>{{ t('agentSwarm.overview.title') }}</h3>
              <p v-html="t('agentSwarm.overview.description')"></p>
              <div class="nodes-grid" style="margin-top: 8px;">
                <div class="node-item" v-for="mode in swarmModes" :key="mode.id">
                  <div class="node-icon">{{ mode.icon }}</div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`agentSwarm.modes.${mode.key}.name`) }}</div>
                    <div class="node-desc" v-html="t(`agentSwarm.modes.${mode.key}.desc`)"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 知识管理 -->
        <section id="knowledge" class="help-section" v-show="activeSection === 'knowledge'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-book"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.knowledge.title') }}</h2>
              <p class="section-desc">{{ t('sections.knowledge.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <h3>{{ t('knowledge.overview.title') }}</h3>
              <p v-html="t('knowledge.overview.description')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('knowledge.fileTypes.title') }}</h3>
              <p v-html="t('knowledge.fileTypes.overview')"></p>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.fileTypes.views.title') }}</strong>
                  <p v-html="t('knowledge.fileTypes.views.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.fileTypes.general.title') }}</strong>
                  <p v-html="t('knowledge.fileTypes.general.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">3</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.fileTypes.special.title') }}</strong>
                  <p v-html="t('knowledge.fileTypes.special.desc')"></p>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('knowledge.features.title') }}</h3>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.features.step1.title') }}</strong>
                  <p>{{ t('knowledge.features.step1.desc') }}</p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.features.step2.title') }}</strong>
                  <p>{{ t('knowledge.features.step2.desc') }}</p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">3</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.features.step3.title') }}</strong>
                  <p>{{ t('knowledge.features.step3.desc') }}</p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">4</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.features.step4.title') }}</strong>
                  <p>{{ t('knowledge.features.step4.desc') }}</p>
                </div>
              </div>
            </div>

            <!-- 文档智能操作（与文档对话）与导出 Word -->
            <div class="content-card">
              <h3>{{ t('knowledge.smart.title') }}</h3>
              <p v-html="t('knowledge.smart.overview')"></p>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.smart.step1.title') }}</strong>
                  <p v-html="t('knowledge.smart.step1.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.smart.step2.title') }}</strong>
                  <p v-html="t('knowledge.smart.step2.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">3</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.smart.step3.title') }}</strong>
                  <p v-html="t('knowledge.smart.step3.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">4</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.smart.step4.title') }}</strong>
                  <p v-html="t('knowledge.smart.step4.desc')"></p>
                </div>
              </div>
              <div class="example-box">
                <div class="example-title">{{ t('knowledge.smart.note.title') }}</div>
                <p v-html="t('knowledge.smart.note.text')"></p>
              </div>
            </div>

            <!-- 文件打开方式：一律独立窗口 -->
            <div class="content-card">
              <h3>{{ t('knowledge.openMode.title') }}</h3>
              <p v-html="t('knowledge.openMode.overview')"></p>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong v-html="t('knowledge.openMode.newWindow.name')"></strong>
                  <p v-html="t('knowledge.openMode.newWindow.desc')"></p>
                </div>
              </div>
              <div class="example-box" style="margin-top: 10px;">
                <div class="example-title">{{ t('knowledge.openMode.effect.title') }}</div>
                <ul class="open-mode-list">
                  <li v-for="(item, i) in t('knowledge.openMode.effect.items')" :key="i" v-html="item"></li>
                </ul>
              </div>
              <div class="example-box" style="margin-top: 10px;">
                <div class="example-title">{{ t('knowledge.openMode.note.title') }}</div>
                <p v-html="t('knowledge.openMode.note.text')"></p>
              </div>
            </div>

            <!-- 浏览器操作：已移至独立「浏览器」章节（见导航栏） -->

            <!-- 局域网协同编辑（重点体现） -->
            <div class="content-card">
              <h3>{{ t('knowledge.collab.title') }}</h3>
              <p v-html="t('knowledge.collab.overview')"></p>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.collab.step1.title') }}</strong>
                  <p v-html="t('knowledge.collab.step1.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.collab.step2.title') }}</strong>
                  <p v-html="t('knowledge.collab.step2.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">3</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.collab.step3.title') }}</strong>
                  <p v-html="t('knowledge.collab.step3.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">4</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.collab.step4.title') }}</strong>
                  <p v-html="t('knowledge.collab.step4.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">5</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.collab.step5.title') }}</strong>
                  <p v-html="t('knowledge.collab.step5.desc')"></p>
                </div>
              </div>
              <div class="example-box">
                <div class="example-title">{{ t('knowledge.collab.note.title') }}</div>
                <p v-html="t('knowledge.collab.note.text')"></p>
              </div>
            </div>

            <!-- 远程文件共享（共享文件夹） -->
            <div class="content-card">
              <h3>{{ t('knowledge.remoteFs.title') }}</h3>
              <p v-html="t('knowledge.remoteFs.overview')"></p>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.remoteFs.step1.title') }}</strong>
                  <p v-html="t('knowledge.remoteFs.step1.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.remoteFs.step2.title') }}</strong>
                  <p v-html="t('knowledge.remoteFs.step2.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">3</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.remoteFs.step3.title') }}</strong>
                  <p v-html="t('knowledge.remoteFs.step3.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">4</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.remoteFs.step4.title') }}</strong>
                  <p v-html="t('knowledge.remoteFs.step4.desc')"></p>
                </div>
              </div>
              <div class="example-box">
                <div class="example-title">{{ t('knowledge.remoteFs.note.title') }}</div>
                <p v-html="t('knowledge.remoteFs.note.text')"></p>
              </div>
            </div>
          </div>
        </section>

        <!-- 知识处理 RAG -->
        <section id="know-rag" class="help-section" v-show="activeSection === 'know-rag'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-stack-overflow"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.know-rag.title') }}</h2>
              <p class="section-desc">{{ t('sections.know-rag.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <h3>{{ t('knowRAG.overview.title') }}</h3>
              <p v-html="t('knowRAG.overview.description')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('knowRAG.workflow.title') }}</h3>
              <div class="flow-diagram">
                <div class="flow-step">
                  <div class="flow-icon">📥</div>
                  <div class="flow-text">{{ t('knowRAG.workflow.step1') }}</div>
                </div>
                <div class="flow-arrow">→</div>
                <div class="flow-step">
                  <div class="flow-icon">✂️</div>
                  <div class="flow-text">{{ t('knowRAG.workflow.step2') }}</div>
                </div>
                <div class="flow-arrow">→</div>
                <div class="flow-step">
                  <div class="flow-icon">🔢</div>
                  <div class="flow-text">{{ t('knowRAG.workflow.step3') }}</div>
                </div>
                <div class="flow-arrow">→</div>
                <div class="flow-step">
                  <div class="flow-icon">🔍</div>
                  <div class="flow-text">{{ t('knowRAG.workflow.step4') }}</div>
                </div>
                <div class="flow-arrow">→</div>
                <div class="flow-step">
                  <div class="flow-icon">💬</div>
                  <div class="flow-text">{{ t('knowRAG.workflow.step5') }}</div>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('knowRAG.views.title') }}</h3>
              <div class="guide-step" v-for="v in ragViewItems" :key="v.key">
                <span class="guide-number">{{ v.n }}</span>
                <div class="guide-content">
                  <strong>{{ t(`knowRAG.views.${v.key}.title`) }}</strong>
                  <p>{{ t(`knowRAG.views.${v.key}.desc`) }}</p>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('knowRAG.qaModes.title') }}</h3>
              <div class="nodes-grid">
                <div class="node-item" v-for="m in qaModes" :key="m.id">
                  <div class="node-icon">{{ m.icon }}</div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`knowRAG.qaModes.${m.key}.name`) }}</div>
                    <div class="node-desc">{{ t(`knowRAG.qaModes.${m.key}.desc`) }}</div>
                  </div>
                </div>
              </div>
              <div class="example-box">
                <div class="example-title">{{ t('knowRAG.qaModes.note.title') }}</div>
                <p v-html="t('knowRAG.qaModes.note.text')"></p>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('knowRAG.config.title') }}</h3>
              <p v-html="t('knowRAG.config.description')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('knowRAG.strategies.title') }}</h3>
              <p v-html="t('knowRAG.strategies.intro')"></p>
              <div class="nodes-grid">
                <div class="node-item" v-for="k in strategyKinds" :key="k.id">
                  <div class="node-icon">{{ k.icon }}</div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`knowRAG.strategies.kinds.${k.key}.name`) }}</div>
                    <div class="node-desc">{{ t(`knowRAG.strategies.kinds.${k.key}.desc`) }}</div>
                  </div>
                </div>
              </div>
              <div class="example-box">
                <div class="example-title">{{ t('knowRAG.strategies.pipeline.title') }}</div>
                <p v-html="t('knowRAG.strategies.pipeline.ingest')"></p>
                <p v-html="t('knowRAG.strategies.pipeline.retrieve')"></p>
              </div>
              <div class="example-box">
                <div class="example-title">{{ t('knowRAG.strategies.params.title') }}</div>
                <p v-html="t('knowRAG.strategies.params.desc')"></p>
              </div>
            </div>
          </div>
        </section>

        <!-- 学习（掌握式记忆与复习） -->
        <section id="learning" class="help-section" v-show="activeSection === 'learning'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-graduation-cap"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.learning.title') }}</h2>
              <p class="section-desc">{{ t('sections.learning.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <h3>{{ t('learning.overview.title') }}</h3>
              <p v-html="t('learning.overview.desc')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('learning.viewsTitle') }}</h3>
              <div class="nodes-grid">
                <div class="node-item" v-for="v in learningViews" :key="v.id">
                  <div class="node-icon"><i class="fa" :class="v.icon"></i></div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`learning.view.${v.key}.name`) }}</div>
                    <div class="node-desc">{{ t(`learning.view.${v.key}.desc`) }}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('learning.mech.title') }}</h3>
              <div class="guide-step" v-for="s in learningSteps" :key="s">
                <span class="guide-number">{{ s }}</span>
                <div class="guide-content">
                  <strong>{{ t(`learning.step${s}.title`) }}</strong>
                  <p v-html="t(`learning.step${s}.desc`)"></p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 通用文件（Markdown / 文档 / 图表 / 白板） -->
        <section id="general-files" class="help-section" v-show="activeSection === 'general-files'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-file-text-o"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.general-files.title') }}</h2>
              <p class="section-desc">{{ t('sections.general-files.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <h3>{{ t('generalFiles.overview.title') }}</h3>
              <p v-html="t('generalFiles.overview.desc')"></p>
              <div class="nodes-grid" style="margin-top: 8px;">
                <div class="node-item" v-for="v in canvasViews" :key="v.id">
                  <div class="node-icon">{{ v.icon }}</div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`knowledge.views.${v.key}.name`) }}</div>
                    <div class="node-desc" v-html="t(`knowledge.views.${v.key}.desc`)"></div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 11 种通用视图的文案与「知识管理」章节共用（knowledge.views.*） -->
            <div class="content-card">
              <h3>{{ t('generalFiles.views.title') }}</h3>
              <div class="views-group">
                <div class="nodes-grid">
                  <div class="node-item" v-for="v in knowledgeViews" :key="v.id">
                    <div class="node-icon">{{ v.icon }}</div>
                    <div class="node-info">
                      <div class="node-name">{{ t(`knowledge.views.${v.key}.name`) }}</div>
                      <div class="node-desc" v-html="t(`knowledge.views.${v.key}.desc`)"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('generalFiles.docs.title') }}</h3>
              <div class="guide-step" v-for="(s, i) in generalDocSteps" :key="i">
                <span class="guide-number">{{ Number(i) + 1 }}</span>
                <div class="guide-content">
                  <strong>{{ s.title }}</strong>
                  <p v-html="s.desc"></p>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('generalFiles.export.title') }}</h3>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('generalFiles.export.items')" :key="i" v-html="item"></li>
              </ul>
            </div>
          </div>
        </section>

        <!-- 专属文件（知识库 / 工作流 / Agent脚手架 / 数据画布） -->
        <section id="special-files" class="help-section" v-show="activeSection === 'special-files'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-files-o"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.special-files.title') }}</h2>
              <p class="section-desc">{{ t('sections.special-files.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <h3>{{ t('specialFiles.overview.title') }}</h3>
              <p v-html="t('specialFiles.overview.desc')"></p>
              <div class="nodes-grid" style="margin-top: 8px;">
                <div class="node-item" v-for="f in specialFileItems" :key="f.id">
                  <div class="node-icon">{{ f.icon }}</div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`specialFiles.items.${f.key}.name`) }}</div>
                    <div class="node-desc" v-html="t(`specialFiles.items.${f.key}.desc`)"></div>
                  </div>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('specialFiles.kb.title') }}</h3>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('specialFiles.kb.items')" :key="i" v-html="item"></li>
              </ul>
            </div>

            <!-- 工作流文件（.flow.yml）：在知识管理中双击打开工作流画布 -->
            <!-- 工作流文件（.flow.yml） -->
            <div class="content-card">
              <h3>{{ t('specialFiles.flow.title') }}</h3>
              <p v-html="t('specialFiles.flow.desc')"></p>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('specialFiles.flow.items')" :key="i" v-html="item"></li>
              </ul>
            </div>

            <div class="content-card">
              <h3>{{ t('workflow.usage.title') }}</h3>
              <ul class="open-mode-list">
                <li v-for="(item, index) in t('workflow.usage.items')" :key="index" v-html="item"></li>
              </ul>
            </div>

            <div class="content-card">
              <h3>{{ t('workflow.nodes.title') }}</h3>
              
              <div class="nodes-grid">
                <div class="node-item" v-for="node in nodes" :key="node.id">
                  <div class="node-icon"><i class="fa" :class="node.icon"></i></div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`workflow.nodes.${node.key}.name`) }}</div>
                    <div class="node-desc">{{ t(`workflow.nodes.${node.key}.desc`) }}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('workflow.variables.title') }}</h3>
              <ul class="open-mode-list">
                <li v-for="(item, index) in t('workflow.variables.items')" :key="index" v-html="item"></li>
              </ul>
            </div>

            <div class="content-card">
              <h3>{{ t('workflow.run.title') }}</h3>
              <ul class="open-mode-list">
                <li v-for="(item, index) in t('workflow.run.items')" :key="index" v-html="item"></li>
              </ul>
            </div>

            <!-- Agent脚手架（.task 任务文件） -->
            <div class="content-card">
              <h3>{{ t('specialFiles.task.title') }}</h3>
              <p v-html="t('specialFiles.task.desc')"></p>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('specialFiles.task.items')" :key="i" v-html="item"></li>
              </ul>
            </div>

            <div class="content-card">
              <h3>{{ t('agentScaffold.overview.title') }}</h3>
              <p v-html="t('agentScaffold.overview.description')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('agentScaffold.scaffolds.title') }}</h3>
              <p v-html="t('agentScaffold.scaffolds.pipeline.desc')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('agentScaffold.scaffolds.presets.title') }}</h3>
              <p class="section-desc" v-html="t('agentScaffold.scaffolds.presets.note')"></p>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong>{{ t('agentScaffold.scaffolds.batch.title') }}</strong>
                  <p>{{ t('agentScaffold.scaffolds.batch.desc') }}</p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong>{{ t('agentScaffold.scaffolds.tabreason.title') }}</strong>
                  <p>{{ t('agentScaffold.scaffolds.tabreason.desc') }}</p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">3</span>
                <div class="guide-content">
                  <strong>{{ t('agentScaffold.scaffolds.file.title') }}</strong>
                  <p>{{ t('agentScaffold.scaffolds.file.desc') }}</p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">4</span>
                <div class="guide-content">
                  <strong>{{ t('agentScaffold.scaffolds.collector.title') }}</strong>
                  <p>{{ t('agentScaffold.scaffolds.collector.desc') }}</p>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('agentScaffold.usage.title') }}</h3>
              <ul>
                <li v-for="(item, index) in t('agentScaffold.usage.items')" :key="index" v-html="item"></li>
              </ul>
            </div>

            <!-- 数据画布（.data 文件） -->
            <div class="content-card">
              <h3>{{ t('specialFiles.data.title') }}</h3>
              <p v-html="t('specialFiles.data.desc')"></p>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('specialFiles.data.items')" :key="i" v-html="item"></li>
              </ul>
            </div>

            <div class="content-card">
              <h3>{{ t('dataCanvas.usage.title') }}</h3>
              <ul class="open-mode-list">
                <li v-for="(item, index) in t('dataCanvas.usage.items')" :key="index" v-html="item"></li>
              </ul>
            </div>

            <div class="content-card">
              <h3>{{ t('dataCanvas.overview.title') }}</h3>
              <p v-html="t('dataCanvas.overview.description')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('dataCanvas.scenarios.title') }}</h3>
              <ul>
                <li v-for="(item, i) in t('dataCanvas.scenarios.items')" :key="i" v-html="item"></li>
              </ul>
            </div>

            <div class="content-card">
              <h3>{{ t('dataCanvas.steps.title') }}</h3>
              <div class="guide-step" v-for="(s, i) in t('dataCanvas.steps.items')" :key="i">
                <span class="guide-number">{{ Number(i) + 1 }}</span>
                <div class="guide-content">
                  <p v-html="s"></p>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('dataCanvas.notes.title') }}</h3>
              <ul>
                <li v-for="(item, i) in t('dataCanvas.notes.items')" :key="i" v-html="item"></li>
              </ul>
            </div>

          </div>
        </section>

        <!-- 设置 -->
        <section id="settings" class="help-section" v-show="activeSection === 'settings'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-cogs"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.settings.title') }}</h2>
              <p class="section-desc">{{ t('sections.settings.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <h3>{{ t('settings.overview.title') }}</h3>
              <p v-html="t('settings.overview.description')"></p>

              <!-- 设置导航总览：按分组逐级列出（分组标题 + 页面清单），比方块卡片更紧凑 -->
              <div v-for="g in settingGroups" :key="g.groupKey" class="settings-tree-group">
                <h4>{{ t(`settings.groups.${g.groupKey}.title`) }}</h4>
                <ul class="settings-tree-list">
                  <li v-for="c in g.children" :key="c.key">
                    <span class="settings-tree-name">{{ t(`settings.groups.${g.groupKey}.items.${c.key}.name`) }}</span>
                    <span class="settings-tree-desc" v-html="t(`settings.groups.${g.groupKey}.items.${c.key}.desc`)"></span>
                  </li>
                </ul>
              </div>
            </div>

            <!-- 上下文窗口与占用圆环 -->
            <div class="content-card">
              <h3>{{ t('settings.contextUsage.title') }}</h3>
              <p v-html="t('settings.contextUsage.overview')"></p>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong>{{ t('settings.contextUsage.step1.title') }}</strong>
                  <p v-html="t('settings.contextUsage.step1.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong>{{ t('settings.contextUsage.step2.title') }}</strong>
                  <p v-html="t('settings.contextUsage.step2.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">3</span>
                <div class="guide-content">
                  <strong>{{ t('settings.contextUsage.step3.title') }}</strong>
                  <p v-html="t('settings.contextUsage.step3.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">4</span>
                <div class="guide-content">
                  <strong>{{ t('settings.contextUsage.step4.title') }}</strong>
                  <p v-html="t('settings.contextUsage.step4.desc')"></p>
                </div>
              </div>
              <div class="example-box">
                <div class="example-title">{{ t('settings.contextUsage.note.title') }}</div>
                <p v-html="t('settings.contextUsage.note.text')"></p>
              </div>
            </div>

            <!-- 联网搜索源（web_search） -->
            <div class="content-card">
              <h3>{{ t('settings.webSearchSources.title') }}</h3>
              <p v-html="t('settings.webSearchSources.overview')"></p>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong>{{ t('settings.webSearchSources.step1.title') }}</strong>
                  <p v-html="t('settings.webSearchSources.step1.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong>{{ t('settings.webSearchSources.step2.title') }}</strong>
                  <p v-html="t('settings.webSearchSources.step2.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">3</span>
                <div class="guide-content">
                  <strong>{{ t('settings.webSearchSources.step3.title') }}</strong>
                  <p v-html="t('settings.webSearchSources.step3.desc')"></p>
                </div>
              </div>
              <div class="example-box">
                <div class="example-title">{{ t('settings.webSearchSources.note.title') }}</div>
                <p v-html="t('settings.webSearchSources.note.text')"></p>
              </div>
            </div>

            <!-- 内置 MCP 服务（浏览器 Agent / Office Word+Excel / drawio 图表 / 文献检索 / PostgreSQL 查询） -->
            <div class="content-card">
              <h3>{{ t('settings.builtinMcp.title') }}</h3>
              <p v-html="t('settings.builtinMcp.overview')"></p>
              <ul class="settings-tree-list">
                <li v-for="m in mcpServices" :key="m.key">
                  <span class="settings-tree-name">{{ t(`settings.builtinMcp.${m.key}.name`) }}</span>
                  <span class="settings-tree-desc" v-html="t(`settings.builtinMcp.${m.key}.desc`)"></span>
                </li>
              </ul>
              <div class="example-box">
                <div class="example-title">{{ t('settings.builtinMcp.note.title') }}</div>
                <p v-html="t('settings.builtinMcp.note.text')"></p>
              </div>
            </div>

            <!-- 关闭按钮行为与托管区（系统托盘） -->
            <div class="content-card">
              <h3>{{ t('settings.closeBehavior.title') }}</h3>
              <p v-html="t('settings.closeBehavior.overview')"></p>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong>{{ t('settings.closeBehavior.quit.title') }}</strong>
                  <p v-html="t('settings.closeBehavior.quit.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong>{{ t('settings.closeBehavior.tray.title') }}</strong>
                  <p v-html="t('settings.closeBehavior.tray.desc')"></p>
                </div>
              </div>
              <div class="example-box">
                <div class="example-title">{{ t('settings.closeBehavior.trayMenu.title') }}</div>
                <ul class="open-mode-list">
                  <li v-html="t('settings.closeBehavior.trayMenu.hover')"></li>
                  <li v-html="t('settings.closeBehavior.trayMenu.leftClick')"></li>
                  <li v-html="t('settings.closeBehavior.trayMenu.rightClick')"></li>
                </ul>
              </div>
              <div class="example-box" style="margin-top: 10px;">
                <div class="example-title">{{ t('settings.closeBehavior.note.title') }}</div>
                <p v-html="t('settings.closeBehavior.note.text')"></p>
              </div>
            </div>

          </div>
        </section>

        <!-- 浏览器 -->
        <section id="browser" class="help-section" v-show="activeSection === 'browser'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-globe"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.browser.title') }}</h2>
              <p class="section-desc">{{ t('sections.browser.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <h3>{{ t('browser.overview.title') }}</h3>
              <p v-html="t('browser.overview.description')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('browser.features.title') }}</h3>
              <div class="nodes-grid">
                <div class="node-item" v-for="f in browserFeatures" :key="f.id">
                  <div class="node-icon">{{ f.icon }}</div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`browser.features.${f.key}.name`) }}</div>
                    <div class="node-desc" v-html="t(`browser.features.${f.key}.desc`)"></div>
                  </div>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('browser.steps.title') }}</h3>
              <div class="guide-step" v-for="(s, i) in browserSteps" :key="i">
                <span class="guide-number">{{ Number(i) + 1 }}</span>
                <div class="guide-content">
                  <strong>{{ s.title }}</strong>
                  <p v-html="s.desc"></p>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('browser.tips.title') }}</h3>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('browser.tips.items')" :key="i" v-html="item"></li>
              </ul>
            </div>
          </div>
        </section>

        <!-- 插件 -->
        <section id="plugins" class="help-section" v-show="activeSection === 'plugins'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-puzzle-piece"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.plugins.title') }}</h2>
              <p class="section-desc">{{ t('sections.plugins.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <h3>{{ t('plugins.overview.title') }}</h3>
              <p v-html="t('plugins.overview.desc')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('plugins.capabilities.title') }}</h3>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('plugins.capabilities.items')" :key="i" v-html="item"></li>
              </ul>
            </div>

            <div class="content-card">
              <h3>{{ t('plugins.manage.title') }}</h3>
              <p v-html="t('plugins.manage.overview')"></p>
              <div class="guide-step" v-for="(s, i) in pluginManageSteps" :key="i">
                <span class="guide-number">{{ Number(i) + 1 }}</span>
                <div class="guide-content">
                  <strong>{{ s.title }}</strong>
                  <p v-html="s.desc"></p>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('plugins.store.title') }}</h3>
              <p v-html="t('plugins.store.desc')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('plugins.dev.title') }}</h3>
              <p v-html="t('plugins.dev.desc')"></p>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('plugins.dev.items')" :key="i" v-html="item"></li>
              </ul>
            </div>

            <div class="content-card">
              <h3>{{ t('plugins.perms.title') }}</h3>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('plugins.perms.items')" :key="i" v-html="item"></li>
              </ul>
              <div class="example-box">
                <div class="example-title">{{ t('plugins.perms.note.title') }}</div>
                <p v-html="t('plugins.perms.note.text')"></p>
              </div>
            </div>
          </div>
        </section>

        <!-- 更新日志（内容来自仓库根目录 CHANGELOG.md / CHANGELOG.en.md，按界面语言选择） -->
        <section id="changelog" class="help-section" v-show="activeSection === 'changelog'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-history"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.changelog.title') }}</h2>
              <p class="section-desc">{{ t('sections.changelog.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <div class="example-box changelog-tip-box">
                <div class="example-title">{{ t('changelog.tip.title') }}</div>
                <p v-html="t('changelog.tip.text')"></p>
              </div>
              <div class="changelog-body" v-html="changelogHtml"></div>
            </div>
          </div>
        </section>

        <!-- 设计参考开源项目（独立导航页） -->
        <section id="credits" class="help-section" v-show="activeSection === 'credits'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-github"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.credits.title') }}</h2>
              <p class="section-desc">{{ t('sections.credits.subtitle') }}</p>
            </div>
          </div>
          <div class="section-content">
            <div class="content-card credit-card">
              <h3>{{ currentLocale === 'zh' ? '设计参考的开源项目' : 'Design references (open source)' }}</h3>
              <p>{{ currentLocale === 'zh' ? '产品部分功能的设计思路参考/借鉴了以下开源项目（仅借鉴设计思路，不复制代码），特此致谢：' : 'Some features draw design inspiration from these open-source projects (ideas only, no code copied) — special thanks:' }}</p>
              <div class="credit-list">
                <div class="credit-item" v-for="c in creditProjects" :key="c.key">
                  <div class="credit-head">
                    <i class="fa" :class="c.icon"></i>
                    <a :href="c.url" target="_blank" rel="noopener">{{ crName(c, currentLocale === 'zh') }}</a>
                  </div>
                  <div class="credit-blurb">{{ crBlurb(c, currentLocale === 'zh') }}</div>
                  <ul class="credit-points">
                    <li v-for="(p, i) in crPoints(c, currentLocale === 'zh')" :key="i">{{ p }}</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 页脚 -->
        <div class="main-footer">
          <div class="footer-content">
            <div class="footer-tip">
              <strong>{{ t('footer.tip.label') }}</strong> {{ t('footer.tip.text') }}
            </div>
            <div class="footer-links">
              <a href="https://github.com/whl1207/Knowledge/issues" target="_blank">
                <i class="fa fa-bug"></i> {{ t('footer.links.feedback') }}
              </a>
              <a href="https://github.com/whl1207/Knowledge" target="_blank">
                <i class="fa fa-github"></i> {{ t('footer.links.source') }}
              </a>
              <a href="https://mineru.com.cn/" target="_blank">
                <i class="fa fa-file"></i> {{ t('footer.links.mineru') }}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { usestore } from '@/store'
import { renderMarkdown } from '@/lib/markdown/render'
// 更新日志：直接引入仓库根目录的 Markdown 文件（改 CHANGELOG.md / CHANGELOG.en.md 即可，无需改组件）
import changelogZhRaw from '../../../CHANGELOG.md?raw'
import changelogEnRaw from '../../../CHANGELOG.en.md?raw'

const store = usestore()

// 根据store的语言设置返回当前语言
const currentLocale = computed(() => store.locales || 'zh')

// 更新日志渲染结果（仅基础 Markdown：标题 / 列表 / 行内代码）；英文界面显示英文档 CHANGELOG.en.md
const changelogHtml = computed(() => renderMarkdown(
  (currentLocale.value === 'en' ? changelogEnRaw : changelogZhRaw) || ''
))

// 国际化函数
const t = (key: string) => {
  const keys = key.split('.')
  // 使用类型断言绕过索引签名限制
  let value: any = (translations as Record<string, any>)[currentLocale.value]
  
  for (const k of keys) {
    if (value && value[k] !== undefined) {
      value = value[k]
    } else {
      // 如果找不到对应语言的翻译，回退到中文
      let fallback: any = translations.zh
      for (const fk of keys) {
        if (fallback && fallback[fk] !== undefined) {
          fallback = fallback[fk]
        } else {
          return key
        }
      }
      return fallback
    }
  }
  return value
}

// 导航展开状态
const activeSection = ref('quick-start')

// 章节定义（图标与软件主界面导航栏一致，均为 fa-icon，标题通过国际化获取）
// 顺序与《使用说明书》目录一致：技能 / Agent 预设归入「设置」，工作流 / 数据画布 / 脚手架归入「专属文件」
const sections = ref([
  { id: 'quick-start', icon: 'fa-home' },
  { id: 'concepts', icon: 'fa-lightbulb-o' },
  { id: 'ai-chat', icon: 'fa-comment' },
  { id: 'knowledge', icon: 'fa-book' },
  { id: 'know-rag', icon: 'fa-stack-overflow' },
  { id: 'learning', icon: 'fa-graduation-cap' },
  { id: 'general-files', icon: 'fa-file-text-o' },
  { id: 'special-files', icon: 'fa-files-o' },
  { id: 'browser', icon: 'fa-globe' },
  { id: 'plugins', icon: 'fa-puzzle-piece' },
  { id: 'settings', icon: 'fa-cogs' },
  { id: 'changelog', icon: 'fa-history' },
  { id: 'credits', icon: 'fa-github' }
])

// 节点列表（带key用于国际化；图标与软件工作流画布一致，均为 fa-icon）
const nodes = ref([
  { id: 1, icon: 'fa-play-circle', key: 'start' },
  { id: 2, icon: 'fa-flag-checkered', key: 'end' },
  { id: 3, icon: 'fa-comment', key: 'answer' },
  { id: 4, icon: 'fa-microchip', key: 'llm' },
  { id: 5, icon: 'fa-robot', key: 'agent' },
  { id: 6, icon: 'fa-code-fork', key: 'ifElse' },
  { id: 7, icon: 'fa-tags', key: 'classifier' },
  { id: 8, icon: 'fa-repeat', key: 'iteration' },
  { id: 9, icon: 'fa-refresh', key: 'loop' },
  { id: 10, icon: 'fa-code', key: 'code' },
  { id: 11, icon: 'fa-file-code-o', key: 'template' },
  { id: 12, icon: 'fa-globe', key: 'http' },
  { id: 13, icon: 'fa-wrench', key: 'tool' },
  { id: 14, icon: 'fa-database', key: 'knowledge' },
  { id: 15, icon: 'fa-object-group', key: 'aggregator' },
  { id: 16, icon: 'fa-pencil-square-o', key: 'assigner' },
  { id: 17, icon: 'fa-list', key: 'listOp' },
  { id: 18, icon: 'fa-filter', key: 'paramExtract' },
  { id: 19, icon: 'fa-file-text-o', key: 'extractor' },
  { id: 20, icon: 'fa-file-word-o', key: 'word' },
  { id: 21, icon: 'fa-file-excel-o', key: 'csv' },
  { id: 22, icon: 'fa-folder-open-o', key: 'localFile' },
  { id: 23, icon: 'fa-book', key: 'localKb' },
  { id: 24, icon: 'fa-plug', key: 'mcp' },
  { id: 25, icon: 'fa-sitemap', key: 'subflow' }
])

// 学习模块视图列表（图标与学习模块顶部标签一致，均为 fa）
const learningViews = ref([
  { id: 1, icon: 'fa-dashboard', key: 'overview' },
  { id: 2, icon: 'fa-map-o', key: 'map' },
  { id: 3, icon: 'fa-refresh', key: 'review' },
  { id: 4, icon: 'fa-exclamation-circle', key: 'mistakes' },
  { id: 5, icon: 'fa-comments-o', key: 'solver' },
  { id: 6, icon: 'fa-graduation-cap', key: 'exam' }
])
// 学习核心机制步骤
const learningSteps = ref([1, 2, 3, 4, 5, 6])

// 设计参考的开源项目（仅借鉴设计思路，不复制代码）：项目名 + 简介 + 借用到本产品的要点
const creditProjects = ref([
  {
    key: 'deeptutor', icon: 'fa-github', url: 'https://github.com/HKUDS/DeepTutor',
    nameZh: 'HKUDS / DeepTutor', nameEn: 'HKUDS / DeepTutor',
    blurbZh: '“学习”模块（掌握式记忆与复习）的设计蓝图', blurbEn: 'Design blueprint of the Learning module (mastery & review)',
    pointsZh: [
      '掌握度引擎：对文件/实体按作答序列计算掌握度，90% 门控判定“已掌握”，低置信度封顶防止“蒙对即掌握”（learningCore.ts）',
      '间隔复习 SRS：答对拉长间隔、连续答对跳档、答错缩短并重置（learningRecord.ts）',
      '错因归因与队列优先级：错题标注原因，近期/连续答错的对象优先复习',
      '跳测与分型复习：可“声明已掌握”跳过已会内容；按 记忆/步骤/概念/设计 类型区分复习节奏'
    ],
    pointsEn: [
      'Mastery engine: per-file/entity mastery from answer sequences, 90% gate for “mastered”, low-confidence caps to avoid one-shot guesses',
      'Spaced repetition: correct lengthens, consecutive-correct jumps, misses shorten & reset',
      'Mistake reasoning & queue priority: tag causes; recent / consecutive misses review first',
      'Test-out & typed review: claim mastered to skip; per-type pacing for memory/procedure/concept/design'
    ]
  },
  {
    key: 'deepseek-harness', icon: 'fa-github', url: 'https://github.com/deepseek-ai/deepseek-harness',
    nameZh: 'DeepSeek-AI / DeepSeek-Harness', nameEn: 'DeepSeek-AI / DeepSeek-Harness',
    blurbZh: 'Agent 编排 / 技能框架 / 集群设计的工程范式', blurbEn: 'Engineering paradigm for agent orchestration, skills and clusters',
    pointsZh: [
      '“模型 + Harness”编排：Agent脚手架与多智能体集群的工具调用约定与可恢复执行',
      '技能(SKILL)框架：SKILL.md 的角色/工具/流程约定，显式触发与自主规划双模式',
      '一子系统一页的文档纪律（docs/subsystems 风格，本地设计决策记录见 docs/设计决策记录.md）',
      'Agent Swarm：多 Agent 分工/状态管理与集群编排（docs/设计决策记录.md §四）'
    ],
    pointsEn: [
      '“Model + harness” orchestration: tool-calling conventions & recoverable execution for Agent Scaffold and multi-agent clusters',
      'Skills (SKILL.md): role/tools/flow conventions with explicit-trigger and autonomous-planning modes',
      'One-page-per-subsystem doc discipline (see the local design decision record in docs/)',
      'Agent Swarm: division of labor, state management and cluster orchestration'
    ]
  },
  {
    key: 'claude-code', icon: 'fa-github', url: 'https://github.com/anthropics/claude-code',
    nameZh: 'Anthropic / Claude Code（Agent Skills 生态）', nameEn: 'Anthropic / Claude Code (Agent Skills ecosystem)',
    blurbZh: '技能格式与智能体对话式工作方式', blurbEn: 'Skill format and the agentic, conversational way of working',
    pointsZh: [
      'SKILL.md（YAML frontmatter + Markdown）文件夹技能格式，作为“技能”模块的载体约定',
      '技能显式触发（如输入技能名/指令）与对话式智能体循环的交互范式',
      '仓库级技能目录的组织方式，供“技能”与“智能体预设”复用'
    ],
    pointsEn: [
      'SKILL.md (YAML frontmatter + Markdown) folder-skill format as the Skills module carrier',
      'Explicit skill invocation and the conversational agent loop interaction style',
      'Repo-level skill directory organization reused by Skills and Agent presets'
    ]
  },
  {
    key: 'codex', icon: 'fa-github', url: 'https://github.com/openai/codex',
    nameZh: 'OpenAI / Codex', nameEn: 'OpenAI / Codex',
    blurbZh: '对话式智能体 CLI 的执行循环', blurbEn: 'Conversational agent-CLI execution loop',
    pointsZh: [
      '“规划 → 执行 → 校验”的 agent loop：对话即任务上下文，逐步完成多步任务',
      'CLI/REPL 交互与任务状态、进度展示约定',
      '文件/搜索/终端等多工具的调用约定与结果落盘'
    ],
    pointsEn: [
      'Plan → act → verify agent loop where the conversation is the task context',
      'CLI/REPL interaction and progress / state presentation',
      'Unified conventions for file / search / terminal tools and persisted results'
    ]
  },
  {
    key: 'dify', icon: 'fa-github', url: 'https://github.com/langgenius/dify',
    nameZh: 'LangGenius / Dify', nameEn: 'LangGenius / Dify',
    blurbZh: '可视化工作流的节点编排模型', blurbEn: 'Visual workflow node-orchestration model',
    pointsZh: [
      '节点类型：开始/结束、文本、知识库检索、推理、条件分支、迭代、聚合等 18 类节点的映射',
      '容器节点 / 子图（parentId）与迭代(Iteration)：数组逐项执行内部流水线',
      '变量引用约定：{{节点名.字段名}}、迭代内 {{节点名.item.字段}}',
      '对应实现：工作流模块（见本地设计决策记录 docs/设计决策记录.md §八）'
    ],
    pointsEn: [
      'Node types: start/end, text, KB retrieval, inference, decision, iteration, aggregation … mapped to our 18 workflow nodes',
      'Container node / subgraph (parentId) and Iteration over arrays inside a pipeline',
      'Variable references: {{node.field}}, {{node.item.field}} inside iterations',
      'Implements the Workflow module (see the local design decision record, docs/)'
    ]
  },
  {
    key: 'vscode', icon: 'fa-github', url: 'https://github.com/microsoft/vscode',
    nameZh: 'Microsoft / Visual Studio Code', nameEn: 'Microsoft / Visual Studio Code',
    blurbZh: '编辑体验与桌面 IDE 界面范式', blurbEn: 'Editing experience and desktop-IDE UI conventions',
    pointsZh: [
      'Monaco 编辑器（源自 VS Code 的编辑器内核）：知识管理“编辑”视图的代码编辑能力与 AI 辅助',
      '工作台式布局与命令式交互：侧边栏 / 标签页 / 底部状态栏等桌面 IDE 范式',
      '协同编辑基于 y-monaco（Yjs × Monaco 双向绑定），多人实时编辑同一文件'
    ],
    pointsEn: [
      'Monaco editor (VS Code’s editor core): code editing and AI assist in the Knowledge “Edit” view',
      'Workbench layout & command-driven interaction: sidebar / tabs / status bar IDE conventions',
      'Collaborative editing via y-monaco (Yjs × Monaco two-way binding) for real-time co-editing'
    ]
  },
  {
    key: 'excalidraw', icon: 'fa-github', url: 'https://github.com/excalidraw/excalidraw',
    nameZh: 'excalidraw / excalidraw', nameEn: 'excalidraw / excalidraw',
    blurbZh: '白板（Excalidraw）视图与协同', blurbEn: 'Whiteboard (Excalidraw) view & collaboration',
    pointsZh: [
      '白板视图直接集成 @excalidraw/excalidraw：.excalidraw 文件在浏览 / 编辑 / 白板等视图绘制',
      '协同会话复用 Excalidraw 原生光标 / 协作者渲染（awareness 广播）',
      '静态资源（字体 / vendor）随构建打包到 dist 根目录，file:// 生产环境也可正常解析'
    ],
    pointsEn: [
      'Whiteboard view integrates @excalidraw/excalidraw: draw .excalidraw files in Browse / Edit / Whiteboard views',
      'Collab sessions reuse Excalidraw native cursors / collaborator rendering (awareness broadcast)',
      'Static assets (fonts / vendor) are bundled to the dist root so file:// production builds resolve them'
    ]
  },
  {
    key: 'drawio', icon: 'fa-github', url: 'https://github.com/jgraph/drawio',
    nameZh: 'draw.io (jgraph/drawio)', nameEn: 'draw.io (jgraph/drawio)',
    blurbZh: 'draw.io 图表（.drawio）视图', blurbEn: 'draw.io diagram (.drawio) view',
    pointsZh: [
      '图表视图内嵌 draw.io 官方 webapp（Apache-2.0），以 embed 模式 + JSON 协议作为宿主通信',
      '运行时随应用打包在 /drawio，纯离线可用；资源获取与裁剪见 scripts/fetch-drawio-webapp.mjs',
      '编辑后由宿主防抖写回原文件；远程文件为只读预览'
    ],
    pointsEn: [
      'Diagram view embeds the official draw.io webapp (Apache-2.0) as a host via embed mode + JSON protocol',
      'Runtime is bundled under /drawio and works fully offline; see scripts/fetch-drawio-webapp.mjs for fetching/pruning',
      'Edits are debounce-saved back to the original file by the host; remote files open read-only'
    ]
  }
])
const crName = (o: { nameZh: string; nameEn: string }, zh: boolean) => (zh ? o.nameZh : o.nameEn)
const crBlurb = (o: { blurbZh: string; blurbEn: string }, zh: boolean) => (zh ? o.blurbZh : o.blurbEn)
const crPoints = (o: { pointsZh: string[]; pointsEn: string[] }, zh: boolean) => (zh ? o.pointsZh : o.pointsEn)

// FAQ列表已移除（常见问题页签已改为「更新日志」，内容来自根目录 CHANGELOG.md / CHANGELOG.en.md）

// 集群运行方式列表（3 档，与主页输入区「运行方式」下拉一致）
const swarmModes = ref([
  { id: 1, icon: '🤖', key: 'auto-mention' },
  { id: 2, icon: '🗣️', key: 'debate' },
  { id: 3, icon: '🧭', key: 'team' }
])

// 浏览器功能列表（帮助中心「浏览器」章节）
const browserFeatures = ref([
  { id: 1, icon: '🗂️', key: 'tabs' },
  { id: 2, icon: '🤖', key: 'aiTab' },
  { id: 3, icon: '⭐', key: 'bookmarks' },
  { id: 4, icon: '💾', key: 'save' },
  { id: 5, icon: '🛠️', key: 'panel' }
])

// 浏览器章节「使用步骤」（文案来自国际化数据；显式数组类型，模板 v-for 索引方可参与运算）
const browserSteps = computed(() => (t('browser.steps.items') || []) as Array<{ title: string; desc: string }>)

// 知识处理问答模式列表
const qaModes = ref([
  { id: 1, icon: '🔍', key: 'similarity' },
  { id: 2, icon: '�', key: 'fileEnhance' },
  { id: 3, icon: '❓', key: 'questionEnhance' },
  { id: 4, icon: '🕸️', key: 'ontology' },
  { id: 5, icon: '🔄', key: 'multiHop' },
  { id: 6, icon: '🧩', key: 'multiStage' },
  { id: 7, icon: '⚡', key: 'agentic' }
])

// 知识处理八个标签页（按顶部导航顺序展示）
const ragViewItems = ref([
  { n: 1, key: 'qa' },
  { n: 2, key: 'file' },
  { n: 3, key: 'slice' },
  { n: 4, key: 'question' },
  { n: 5, key: 'card' },
  { n: 6, key: 'ontology' },
  { n: 7, key: 'test' },
  { n: 8, key: 'settings' }
])

// 设置导航分组（对应 Set.vue 左侧导航顺序）
const settingGroups = ref([
  { groupKey: 'basic', children: [
    { icon: 'fa-eye', key: 'view' },
    { icon: 'fa-th-large', key: 'features' },
    { icon: 'fa-database', key: 'data' },
    { icon: 'fa-link', key: 'fileassoc' },
    { icon: 'fa-ellipsis-h', key: 'other' }
  ] },
  { groupKey: 'models', children: [
    { icon: 'fa-server', key: 'llm' },
    { icon: 'fa-cubes', key: 'llm-embed' },
    { icon: 'fa-key', key: 'credentials' }
  ] },
  { groupKey: 'collabGroup', children: [
    { icon: 'fa-globe', key: 'share' },
    { icon: 'fa-users', key: 'collab' },
    { icon: 'fa-shield', key: 'perm' }
  ] },
  { groupKey: 'speech', children: [
    { icon: 'fa-volume-up', key: 'tts' },
    { icon: 'fa-microphone', key: 'asr' }
  ] },
  { groupKey: 'tools', children: [
    { icon: 'fa-wrench', key: 'tools' },
    { icon: 'fa-search', key: 'search' },
    { icon: 'fa-plug', key: 'mcp' },
    { icon: 'fa-list-ul', key: 'toolregistry' }
  ] },
  { groupKey: 'plugin', children: [
    { icon: 'fa-puzzle-piece', key: 'plugin' },
    { icon: 'fa-shopping-cart', key: 'plugin-store' }
  ] },
  { groupKey: 'skills', children: [
    { icon: 'fa-drupal', key: 'manage' },
    { icon: 'fa-shopping-cart', key: 'store' }
  ] },
  { groupKey: 'agent', children: [
    { icon: 'fa-address-book-o', key: 'presets' },
    { icon: 'fa-cogs', key: 'console' },
    { icon: 'fa-list-alt', key: 'log' }
  ] },
  { groupKey: 'helpg', children: [
    { icon: 'fa-question-circle', key: 'help' }
  ] }
])

// 内置 MCP 服务清单（设置章节按清单逐条展示，键与 settings.builtinMcp.* 对应）
const mcpServices = ref([
  { key: 'browser' },
  { key: 'office' },
  { key: 'drawio' },
  { key: 'literature' },
  { key: 'postgres' },
  { key: 'pluginDev' }
])

// 知识处理自定义检索策略类型列表（对应策略配置的四种 kind）
const strategyKinds = ref([
  { id: 1, icon: '🛤️', key: 'pipeline' },
  { id: 2, icon: '🧩', key: 'mapreduce' },
  { id: 3, icon: '⚡', key: 'agentic' },
  { id: 4, icon: '🔀', key: 'hybrid' }
])

// 知识管理视图列表（顺序与命名同 src/lib/knowFile/fileViews.ts：浏览/源码编辑/可视编辑/思维导图/演示）
const knowledgeViews = ref([
  { id: 1, icon: '📖', key: 'browse' },
  { id: 2, icon: '✏️', key: 'edit' },
  { id: 3, icon: '🧱', key: 'blockedit' },
  { id: 4, icon: '🧠', key: 'mindmap' },
  { id: 5, icon: '📂', key: 'files' },
  { id: 6, icon: '📋', key: 'kanban' },
  { id: 7, icon: '🕸️', key: 'graph' },
  { id: 8, icon: '🗓️', key: 'calendar' },
  { id: 9, icon: '📍', key: 'map' },
  { id: 10, icon: '📝', key: 'table' },
  { id: 11, icon: '🖥️', key: 'presentation' }
])

// 文件专属视图 / 特殊文件：白板与图表是画布视图，工作流是流程画布，知识库与任务文件交由对应模块打开
const knowledgeFileViews = ref([
  { id: 1, icon: '🎨', key: 'excalidraw' },
  { id: 2, icon: '📐', key: 'drawio' },
  { id: 3, icon: '🔀', key: 'flow' },
  { id: 4, icon: '📚', key: 'kb' },
  { id: 5, icon: '🧰', key: 'task' }
])

// 「通用文件」章节展示的两张画布（白板 / 图表）；工作流 / 知识库 / 脚手架由「专属文件」章节负责
const canvasViews = computed(() => knowledgeFileViews.value.filter((v) => ['excalidraw', 'drawio'].includes(v.key)))

// 「专属文件」章节的四类文件（知识库 / 工作流 / Agent脚手架 / 数据画布）
const specialFileItems = ref([
  { id: 1, icon: '📚', key: 'kb' },
  { id: 2, icon: '🔀', key: 'flow' },
  { id: 3, icon: '🧰', key: 'task' },
  { id: 4, icon: '📊', key: 'data' }
])

// 「概念介绍」章节的关键概念卡片
const conceptItems = ref([
  { id: 1, icon: '🧠', key: 'llm' },
  { id: 2, icon: '🤖', key: 'agent' },
  { id: 3, icon: '🧰', key: 'tool' },
  { id: 4, icon: '📜', key: 'ptc' },
  { id: 5, icon: '🔌', key: 'mcp' },
  { id: 6, icon: '🎓', key: 'skill' },
  { id: 7, icon: '📚', key: 'kb' },
  { id: 8, icon: '🧩', key: 'plugin' }
])

// 结构化的文案列表（显式数组类型，模板 v-for 索引方可参与运算）
const faqItems = computed(() => (t('quickStart.faq.items') || []) as Array<{ q: string; a: string }>)
const generalDocSteps = computed(() => (t('generalFiles.docs.items') || []) as Array<{ title: string; desc: string }>)
const pluginManageSteps = computed(() => (t('plugins.manage.items') || []) as Array<{ title: string; desc: string }>)

// AI 对话方案列表（五种：普通 / 知识库 / 工作流 / 智能体 / 集群；PTC 为智能体的呈现方式，见「智能体对话」）
const aiChatSchemes = ref([
  { id: 1, icon: '💬', key: 'normal' },
  { id: 2, icon: '📚', key: 'retrieval' },
  { id: 3, icon: '🔗', key: 'workflow' },
  { id: 4, icon: '🤖', key: 'agent' },
  { id: 5, icon: '👥', key: 'swarm' }
])

// 切换FAQ

// 中英文翻译数据
const translations = {
  zh: {
    nav: {
      title: 'AI-KM 帮助'
    },
    header: {
      title: 'AI-KM 智能生产力平台',
      subtitle: '新手友好指南 · 十一个章节'
    },
    sections: {
      'quick-start': {
        title: '快速开始',
        subtitle: '5 分钟上手 + 常见问题'
      },
      'concepts': {
        title: '概念介绍',
        subtitle: '先弄清这些名词'
      },
      'ai-chat': {
        title: '智能推理',
        subtitle: '主页 AI 对话 · 五种模式'
      },
      'knowledge': {
        title: '知识管理',
        subtitle: '文件中心与协作'
      },
      'know-rag': {
        title: '知识处理',
        subtitle: 'RAG 知识库'
      },
      'learning': {
        title: '学习',
        subtitle: '掌握式记忆与复习'
      },
      'general-files': {
        title: '通用文件',
        subtitle: 'Markdown · 文档 · 图表 · 白板'
      },
      'special-files': {
        title: '专属文件',
        subtitle: '知识库 · 工作流 · Agent · 数据画布'
      },
      'browser': {
        title: '浏览器',
        subtitle: '内置网页浏览与 AI 网页操作'
      },
      'plugins': {
        title: '插件',
        subtitle: '扩展工具与界面'
      },
      'settings': {
        title: '设置',
        subtitle: '集中管理'
      },
      'changelog': {
        title: '更新日志',
        subtitle: '历次功能变更'
      },
      'credits': {
        title: '设计参考',
        subtitle: '借鉴的开源项目'
      }
    },
    changelog: {
      tip: {
        title: '📝 关于本页：',
        text: '内容随版本一起打包，源文件为仓库根目录的 <code>CHANGELOG.md</code>（英文界面读 <code>CHANGELOG.en.md</code>）；新版本的功能变更会追加在<strong>最上方</strong>，因此维护时只需编辑该文件，无需改动界面。'
      }
    },
    quickStart: {
      overview: 'AI-KM 是一款<strong>本地优先的桌面 AI 知识管理平台</strong>：AI 对话（RAG 知识问答 / 智能体对话）、文档与白板管理、知识处理（切片向量化构建 .kb 知识库）、掌握式学习与间隔复习、可视化工作流、Agent脚手架与多智能体集群协作、知识管理里的任务看板一应俱全；数据默认保存在本地，支持离线使用。以下 6 步带你快速上手：',
      tags: ['AI 对话', '知识管理', '知识处理', '掌握式学习', '可视化工作流', 'Agent脚手架', '多智能体集群', '任务看板'],
      step1: {
        title: '部署 AI 环境',
        items: [
          '<strong>本地模型（推荐）</strong>：安装 Ollama — 访问 <a href="https://ollama.com/" target="_blank">ollama.com</a> 下载安装，运行 <code>ollama serve</code> 启动服务，然后 <code>ollama pull qwen3</code> 下载推荐模型；「设置 → 模型 → Ollama」的 <strong>模型加载状态</strong> 面板会列出本地模型（类型 / 生效上下文 / 上限）并可直接加载、卸载',
          '<strong>LM Studio</strong>：从 <a href="https://lmstudio.ai/" target="_blank">lmstudio.ai</a> 下载安装，加载模型后开启本地服务器，在设置中选择 "LM Studio" 类型，地址填 <code>http://localhost:1234</code>；「设置 → 模型 → LM Studio」的 <strong>模型加载状态</strong> 面板会列出全部模型、是否已加载、LM Studio 设置的上限，并可直接加载 / 卸载',
          '<strong>OpenAI</strong>：在设置中选择 "OpenAI" 类型，填入 API 密钥，地址 <code>https://api.openai.com/v1</code>，模型如 gpt-4o、gpt-4o-mini',
          '<strong>DeepSeek</strong>：在设置中选择 "DeepSeek" 类型，填入 API 密钥，地址 <code>https://api.deepseek.com</code>，选择接口样式（Chat Completions / Responses API）与模型（如 deepseek-flash），可点「查询余额」查看账户余额'
        ]
      },
      step2: {
        title: '体验智能对话',
        items: [
          '点击左侧导航栏的 <strong>AI 图标</strong> 进入对话界面',
          '点击"新建聊天"创建一个新对话，顶部选择已部署的 AI 模型',
          '在输入框中直接提问，如"你好"、"介绍一下你自己"等',
          '如果要让 AI 参考你的知识库，点击输入框上方的书本图标 📚 选择 .kb 知识库文件',
          'AI 会自动结合知识库内容回答问题，支持多轮连续对话'
        ]
      },
      step3: {
        title: '记录任务与灵感',
        items: [
          '点击顶部导航栏的 <strong>知识管理</strong>，在左侧面板的「视图」里勾选 <strong>看板</strong>',
          '点看板左下角状态栏的 <strong>+</strong> 打开<strong>新建卡片</strong>面板：填名称即会在当前文件夹建一个 Markdown 文件，还能顺手选择状态与开始 / 结束时间（都可留空，开始时间默认今天）；卡片右侧的日历图标可随时设置 / 修改它的开始 / 结束时间',
          '卡片可<strong>拖到别的列改状态</strong>、<strong>右键</strong>打开菜单（归档 / 移入某个取值 / 删除等）；顶部气泡可按取值多选筛选，状态栏「分组」可换成任意属性',
          '任务就是普通 Markdown 文件：可在<strong>日历</strong>视图里拖拽排期、在<strong>表格</strong>视图批量改属性；看板状态栏「状态分类」可自定义分类顺序与图标'
        ]
      },
      step4: {
        title: '弄清概念、认识文件类型',
        items: [
          '先看 <strong>概念介绍</strong>：大模型 / 智能体 / 工具 / MCP / 技能 / 知识库 / PTC / 插件各是什么，一口气理清',
          '文件分两类：<strong>通用文件</strong>（Markdown / Word / PDF / 图片 / 网页，以及 Excalidraw 白板、draw.io 图表）与<strong>专属文件</strong>（<code>.kb</code> 知识库、<code>.flow.yml</code> 工作流、<code>.task</code> 脚手架、<code>.data</code> 数据画布），双击即用对应视图打开',
          '需要扩展能力时看<strong>插件</strong>：给智能体加工具，或往界面加主面板 / 设置页签 / 快捷键'
        ]
      },
      step5: {
        title: '知识库体验',
        items: [
          '进入 <strong>知识管理</strong> 模块，点击"导入"选择本地文档（支持 Markdown、PDF、Word、TXT 格式）',
          '建议先用 <a href="https://mineru.com.cn/" target="_blank">MinerU</a> 将 PDF 转换为 Markdown 格式，以获得更好的知识切片效果',
          '选择需要处理的文件夹，点击"处理"按钮，系统会自动进行文本切片和向量化',
          '处理完成后生成 .kb 知识库文件，可在智能对话或工作流中引用',
          '在智能对话中关联知识库后，AI 的回答将基于你提供的文档内容',
          '想和同事一起编辑？试试 <strong>局域网协同编辑</strong>：在知识管理中打开一个文件或白板，点击协作按钮共享给同一局域网的其他成员，实时同步编辑（详见"知识管理"章节）'
        ]
      },
      step6: {
        title: '探索 Agent 功能',
        items: [
          '<strong>技能</strong>（技能管理 / 技能商店 / Agent 预设）统一收在 <strong>设置 → 技能</strong> 中，不再单独占用顶部导航：商店可下载新技能，管理可查看 / 编辑技能文件，并可在 <strong>Agent 预设</strong> 里创建可复用模板、以该角色对话',
          '需要"写一段程序组合多步工具调用"时，用内置的 <strong>PTC 智能体</strong> 预设（设置 → 智能体 → 预设 → 工具 可把任意预设的<strong>呈现方式</strong>切到 PTC）：描述需求后 AI 会写一段 TypeScript 程序经 run_code 组合调用工具，消息里会展示程序、返回值与程序内调用的工具，聊天 / 工作流 / 集群 / 批量通用',
          '需要多智能体协作时，把模式切到 <strong>集群</strong>：勾选多个 Agent 预设作为成员（成员在「设置 → 智能体 → 预设」维护），发送任务后成员依次发言，可 <strong>@成员名</strong> 点名某一位',
          '<strong>脚手架任务</strong>已成为知识管理里的一种文件类型（<code>.task</code>）：新建 / 双击 <code>.task</code> 即在<strong>独立窗口</strong>里打开它的专属「脚手架」视图（这里唯一的脚手架；批量智能体运行 / 表格定向推理 / 文件采集 / 链接采集是它的四种预设），任务可中断续跑、后台继续',
          '<strong>数据画布</strong>不再是顶层模块，而是<strong>知识管理中的一种文件类型</strong>（<code>.data</code>）：在文件树里打开 <code>.data</code> 即进入画布模块（画布建模 + 表单录入 + 图表看板），内容会自动保存回该文件'
        ]
      },
      faq: {
        title: '常见问题（FAQ）',
        items: [
          { q: 'Q：聊天时提示未连接怎么办？', a: '到 <strong>设置 → 模型 → 来源</strong> 确认 AI 类型与地址 / Key 正确，点「测试连接」；本地 Ollama / LM Studio 请确认服务已启动。要让主页默认用它，还要再点一次「设为默认」。' },
          { q: 'Q：知识处理提示未在运行或模型配置错误？', a: '知识处理跟随全局 AI 配置：确认当前来源已「测试连接 / API 状态」成功、所选模型存在，并配置好<strong>默认嵌入模型</strong>（如 <code>nomic-embed-text</code>）；LM Studio 还要求该嵌入模型已被加载（或在 Server 里开启 Just-In-Time 加载）。' },
          { q: 'Q：我的数据安全吗？能离线用吗？', a: '所有对话、知识库与配置默认保存在本地，不会上传到第三方服务器（在线 API 请求除外）；使用本地模型（Ollama / LM Studio）即可完全离线，语音识别也可选本地 ONNX Whisper。' },
          { q: 'Q：新手先学哪个模块？', a: '建议顺序：<strong>设置</strong>（配模型）→ <strong>智能推理</strong>（聊天）→ <strong>知识管理</strong>（建文件 / 看板记任务）→ <strong>知识处理</strong>（建知识库）→ <strong>学习</strong>（复习掌握）→ 通用文件 / 专属文件 → 插件。' },
          { q: 'Q：PDF 怎么进知识库？', a: '在<strong>知识处理 → 文件</strong>里，对缺少同名 md 的 PDF 点「转换」生成 Markdown，再走切片 → 向量化 → 保存流程。' },
          { q: 'Q：可以在手机上用吗？', a: '可以。在 <strong>设置 → 协作 → 共享 → 局域网共享</strong> 启动共享，用手机浏览器访问显示的局域网地址即可聊天：网页端会显示<strong>上方导航栏（含设置）</strong>，可像桌面一样切换主页 / 知识管理 / 知识处理 / 学习等面板；最小化、最大化、关闭与「浏览器 Agent」入口是桌面专属（网页里做不了，会自动隐藏）。若还想让手机<strong>浏览 / 编辑主机文件</strong>，到 <strong>协作 → 权限 → 文件访问</strong> 打开「只读」或「可写」：所有操作都由主机代做，且只能访问「共享」页里设置的共享目录，越界请求会被拒绝。模型来源与主机自动对齐：主机在「模型 → 来源」里关掉的来源网页端不再显示，模型探测也由主机执行（桌面端能刷出来的模型，网页端点一下模型下拉同样能刷出来）。' },
          { q: 'Q：手机上能不看电脑单独用吗？', a: '可以。安卓版可打包成 APK 装到手机（构建方式见 README 的 Android 章节），<strong>离线可用</strong>：文件默认存在应用沙箱里。想访问自己的资料，点「打开文件夹」调起系统界面授权一个目录（如「文档 / 知识库」），之后该目录内的文件可正常浏览、预览、编辑与增删改，重启后授权依然有效；打开文件会在<strong>应用内浮层窗口</strong>里显示（与设置一样），且<strong>单击文件即打开、单击文件夹即进入</strong>。<strong>系统返回手势 / 返回键按界面栈逐级回退</strong>：先关弹窗与界面内浮层，再退设置内部（内容 → 分类列表）、主页（对话 → 聊天列表）、知识管理的文件树抽屉，然后回主页，主页连按两次才退出应用。<strong>智能体也在手机上跑</strong>：可在本机读写手机文件（含授权目录）、检索知识库、抓取网页、提问与维护计划 / 待办，不依赖桌面主机；跑 Python、shell、子代理、MCP、技能这些需要桌面能力的行为会明确提示不可用。在线模型（DeepSeek 等）与<strong>插件</strong>同样不需要主机：插件在手机上由应用本地装载（插件目录在应用私有目录，点「安装插件」可从手机里选文件夹装入，插件里也能调起系统文件选择器读写手机文件），<strong>窗口缩放</strong>（设置 → 基础）在手机上同样生效并会记住。连局域网里的 Ollama / LM Studio 也可直接填 <code>http://192.168.x.x:11434</code>（已放行明文 HTTP）。Office 导出、Python 沙箱、表格、技能库这些重能力在手机上暂不可用。' },
          { q: 'Q：加载知识库后提示检测到未完成的本体构建进度？', a: '这是<strong>断点续建</strong>机制：未跑完的本体构建不会自动继续，需在底部状态栏或「百科」页点「继续」才恢复；清空本体后按钮应显示 ▶ 开始，若仍显示「继续」，重进或再清一次即可。' },
          { q: 'Q：为什么有些实体没有关联到切片？', a: '关联采用「切片文本精确包含实体名」的匹配；模型给出归纳名而原文没有原词时会保留为<strong>孤立概念</strong>，可在「百科」页手动添加实体补关联。' }
        ]
      }
    },
    concepts: {
      overview: {
        title: '本软件是怎么搭起来的',
        desc: '本软件把<strong>模型 + 工具 + 知识</strong>组装成一个能替你干活的助手。看懂下面这几个名词，后面所有章节都会变得很直白——它们大多只是<strong>在设置里的哪一页、在对话里怎么用</strong>的区别。'
      },
      list: {
        title: '八个关键概念'
      },
      items: {
        llm: { name: '大模型（LLM）', desc: '软件的<strong>大脑</strong>，负责理解你的话并生成回答。可接本地模型（<code>Ollama</code> / <code>LM Studio</code>，完全离线）或在线模型（<code>DeepSeek</code> / <code>OpenAI</code> / <code>Anthropic</code> / <code>Google</code> / <code>Azure</code> / <code>GPUStack</code> / 自定义），配置在 <strong>设置 → 模型 → 来源</strong>；对话、知识处理、学习、工作流、Agent 共用这份全局配置。' },
        agent: { name: '智能体（Agent）', desc: '<strong>大模型 + 角色设定 + 一组工具</strong>。它会自己规划步骤、调用工具、看结果再决定下一步，直到把任务做完。角色由<strong>Agent 预设</strong>定义（系统提示 / 模型 / 工具 / 技能 / 知识库 / MCP），主页点 👤 选用即进入智能体模式。' },
        tool: { name: '工具（工具调用）', desc: '智能体能主动调用的能力：读写文件、搜索网页、打开网页、执行代码、检索知识库等。你不需要手动点，模型自己决定<strong>用哪个、传什么参数</strong>；带副作用的工具走<strong>审批策略</strong>。' },
        ptc: { name: '程序化工具调用（PTC）', desc: '默认逐个调用工具；PTC 下模型只看到 <code>run_code</code>，它<strong>写一段 TypeScript 程序</strong>在程序里组合调用多个工具（如循环处理 20 个文件再汇总）。往返更少、批处理更省 token，消息里会展示程序、返回值与程序内调用过的工具。' },
        mcp: { name: 'MCP（模型上下文协议）', desc: '接入外部工具能力的通用协议：把一堆函数打包成一个服务，智能体 / 工作流 / 外部客户端按同一套方式调用。软件<strong>内置 6 个进程内 MCP 服务</strong>（浏览器 Agent / Office 文档 / drawio / 文献检索 / PostgreSQL / 插件开发参考），也可接入外部服务或对外开放。' },
        skill: { name: '技能（Skill）', desc: '一份<strong>怎么写、按什么步骤做</strong>的操作手册：一个文件夹 + 一个 <code>SKILL.md</code>。它不提供新工具，而是教智能体用好已有能力；聊天里输入 <code>$技能名 任务</code> 显式触发，或让智能体按描述自动匹配。' },
        kb: { name: '知识库（.kb）与 RAG', desc: '把你的文档<strong>切片 → 向量化</strong>之后得到的可检索索引。对话时先检索最相关的切片（<strong>RAG</strong>），再交给模型作答——回答有依据、可溯源。由<strong>知识处理</strong>构建，可被主页知识库模式、智能体、工作流与<strong>学习</strong>模块使用。' },
        plugin: { name: '插件（Plugin）', desc: '给软件本身增加能力的扩展包：既能给智能体<strong>加工具</strong>，也能往界面<strong>加主面板 / 设置页签 / 快捷键</strong>。权限按清单声明（文件 / 命令 / 网络 / 会话日志 / 大模型），未申请的一律拒绝。' }
      },
      more: {
        title: '另外几个常见名词',
        desc: '后面章节还会反复出现这几个词，先各记一句话：',
        items: [
          '<strong>工作流（.flow.yml）</strong>：把检索 → 判断 → 生成 → 导出这类步骤用节点和连线画出来，一键按固定流程执行（见<strong>专属文件</strong>）。',
          '<strong>集群</strong>：主页的一种对话模式，多个 Agent 预设作为成员分工协作（见<strong>智能推理</strong>）。',
          '<strong>本体图谱</strong>：知识处理从文档里抽出的<strong>实体 + 关系</strong>，用于图谱问答与增强检索（见<strong>知识处理</strong>）。',
          '<strong>脚手架（.task）</strong>：通用 Agent 执行框架，一个文件 = 一个可反复运行的批量任务（见<strong>专属文件</strong>）。',
          '<strong>数据画布（.data）</strong>：无代码数据建模，画布定义对象与字段，再用表单录入、图表查看（见<strong>专属文件</strong>）。'
        ]
      }
    },
    generalFiles: {
      overview: {
        title: '什么是通用文件？',
        desc: '<strong>通用文件</strong>是你日常真正读写的东西：Markdown 笔记、Word / PDF 文档、图片音视频、纯文本、Excel、本地网页，以及 <strong>Mermaid 图表</strong>（<code>.mmd</code>）、<strong>Excalidraw 白板</strong>与 <strong>draw.io 图表</strong>。它们都在<strong>知识管理</strong>里创建与打开，双击即用最合适的视图渲染。'
      },
      views: {
        title: '通用视图（11 种）'
      },
      docs: {
        title: 'Markdown 与文档编辑',
        items: [
          { title: '浏览', desc: '只读预览：公式 / 代码高亮 / 表格 / 图片 / Mermaid / 内嵌 draw.io 图表都能渲染；底部状态栏还有 ✨ 智能操作（与当前文档对话）与 ⬇ 导出文档。' },
          { title: '源码编辑', desc: 'Monaco 编辑器直接改 Markdown 原文（含 YAML 头），支持 AI 辅助与拖入图片 / 文件自动生成引用链接；<code>.py</code> / <code>.json</code> 等代码与数据文件也在这里以文本方式打开。' },
          { title: '可视编辑（块编辑）', desc: '块式富文本：输入 <code>/</code> 唤出块类型菜单，块手柄菜单的「转换为」可在标题 / 列表 / 表格 / 代码之间转换。' },
          { title: '思维导图 / 演示', desc: '导图按 Markdown 标题层级生成；演示把 Markdown 转成幻灯片（按 <code>---</code> 或智能切分分页，支持目录 / 全屏 / 主题切换）；两者在触屏上都可左右滑动翻页。' },
          { title: '其它文档类型', desc: 'Word 自动转 Markdown 渲染并可导出 Markdown；PDF 支持分页浏览、缩放、OCR 与<strong>原地翻译</strong>；Excel 转 Markdown 表格；图片 / 视频 / 纯文本各有对应预览；本地网页（<code>.html</code> / <code>.htm</code>）默认交给<strong>内置浏览器</strong>渲染。' },
          { title: 'Mermaid 图表（.mmd / .mermaid）', desc: '<strong>浏览</strong>视图把整份源码渲染成一张图，点图可放大 / 平移 / 导出 PNG、SVG；<strong>源码编辑</strong>视图改文本。渲染失败时原地显示错误与源码便于修正；空文件默认直接进源码编辑。' },
          { title: 'PDF 页面管理', desc: 'PDF 状态栏的「页面管理」把整份 PDF 拆成一页一张的缩略图：可把别的 PDF <strong>合并</strong>进来、勾选后<strong>删除</strong>整页、拖拽缩略图<strong>调整顺序</strong>、单页或整组<strong>旋转</strong>；确认后由 pdf-lib 重新组页，可覆盖原文件或另存为新 PDF（远程预览只能另存）。' }
        ]
      },
      export: {
        title: '导出与打印',
        items: [
          '浏览视图的<strong>导出文档</strong>菜单提供导出 Markdown / Word / PDF，其中 Markdown 与 Word 会弹出另存为对话框（Word 另有公文 / 中文论文 / 英文论文 / 自定义样式，公式优先转为 Word 原生公式）。',
          'draw.io 图表支持导出 PNG / JPEG / SVG / XML 与 PDF，并可<strong>复制为图片</strong>（<code>Ctrl+Alt+X</code>）直接粘贴到 Word / PPT。',
          '导出与打印都走本地通道，<strong>离线可用</strong>。'
        ]
      }
    },
    specialFiles: {
      overview: {
        title: '什么是专属文件？',
        desc: '<strong>专属文件</strong>是本软件自己定义的文件类型：它们都有专属的处理模块或编辑器，在知识管理里新建、双击即用对应视图打开。'
      },
      items: {
        kb: { name: '知识库 .kb', desc: '由「知识处理」切片 / 向量化生成的可检索索引；双击跳到<strong>知识处理</strong>加载该库。' },
        flow: { name: '工作流 .flow.yml', desc: '节点 + 连线的流程编排（可反复运行的固定流程）；双击在独立窗口里打开<strong>工作流画布</strong>。' },
        task: { name: 'Agent脚手架 .task', desc: '一个文件 = 一个可反复运行的批量 Agent 任务；双击在独立窗口里打开<strong>脚手架视图</strong>。' },
        data: { name: '数据画布 .data', desc: '无代码数据建模：对象 + 字段 + 表单 + 图表；双击在独立窗口里打开<strong>数据画布视图</strong>。' }
      },
      kb: {
        title: '知识库文件（.kb）',
        items: [
          '<strong>怎么来</strong>：在<strong>知识处理</strong>里打开工作区 → 文件 → 切片 → 向量化 → 保存知识库。',
          '<strong>怎么用</strong>：双击 <code>.kb</code> 会跳到<strong>知识处理</strong>加载它，可检索、问答、重新切片；主页<strong>知识库模式</strong>选中它即进入检索 + 回答；智能体预设开启「访问知识库」后会通过 <code>kb_search</code> 自动检索；<strong>学习</strong>模块也围绕它生成练习与复习内容。',
          '<strong>在哪管</strong>：一个 <code>.kb</code> 支持多个版本，工具栏可切换 / 保存；学习记录单独存在同目录的 <code>&lt;库名&gt;.learning</code> 里，不会写进 <code>.kb</code>。'
        ]
      },
      flow: {
        title: '工作流文件（.flow.yml）',
        desc: '工作流把大模型、代码、网络请求、知识检索、文件处理等步骤<strong>拖拽连线</strong>串成自动化流程，一键运行；流程本身就是一个 <code>.flow.yml</code> 文件（Dify 应用 DSL，可直接被 Dify 导入、也能打开 Dify 导出的应用文件）。',
        items: [
          '<strong>怎么来</strong>：文件树顶部 ➕ 创建文件 → 类型选<strong>工作流</strong>（生成 <code>.flow.yml</code> 的空骨架）。',
          '<strong>怎么用</strong>：双击即在<strong>独立窗口</strong>里打开工作流画布——添加节点、连线、在右侧属性面板配参数，点工具栏<strong>运行</strong>查看每个节点的结果；在主页用<strong>工作流模式</strong>选中同一个 <code>.flow.yml</code> 也能按节点执行。',
          '<strong>在哪管</strong>：一个文件 = 一个流程，复制 / 改名即可做变体；文件名后的 ● 表示有未保存改动，<code>Ctrl+S</code> 写回文件。'
        ]
      },
      task: {
        title: 'Agent脚手架任务（.task）',
        desc: 'Agent脚手架是<strong>通用 Agent 执行框架</strong>（应用内称 Harness）：以<strong>表格驱动</strong>的方式跑批量任务——一个 <code>.task</code> 文件就是一个独立任务，可中断续跑、后台继续。',
        items: [
          '<strong>怎么来</strong>：文件树 / 文件视图右键 → <strong>新建 → 脚手架</strong>（生成 <code>.task</code> 空任务骨架），建好即在独立窗口里打开。',
          '<strong>怎么用</strong>：任务页左上<strong>预设</strong>下拉一键套用四种形态——<strong>批量智能体运行</strong>（每行一个独立智能体）/ <strong>表格定向推理</strong>（逐行推理、补字段）/ <strong>文件采集表格</strong>（扫文件夹提字段）/ <strong>链接采集表格</strong>（逐页抓取 + 链接跟随）；也可以手动组合<strong>来源 × 执行方式 × 输出方式</strong>三个维度。',
          '<strong>在哪管</strong>：左列卡片顶部的<strong>保存</strong>写回这个 <code>.task</code>（<strong>另存为</strong>另存副本）；「执行与配置」里可勾选是否把图谱数据 / 运行日志写进任务文件。'
        ]
      },
      data: {
        title: '数据画布文件（.data）',
        desc: '数据画布是<strong>无代码数据建模</strong>：用节点与连线搭出表格 / 参数 / 图表 / 子画布等结构，再用表单录入数据、用图表看结果；它是知识管理里的一种文件类型（<code>.data</code>）。',
        items: [
          '<strong>怎么来</strong>：文件树顶部 ➕ 创建文件 → 类型选<strong>数据画布</strong>（生成 <code>.data</code>），或在文件树 / 文件视图右键 → 新建 → 数据画布；新建后是空画布，可直接建模。',
          '<strong>怎么用</strong>：在知识管理里打开 <code>.data</code>（浏览 / 可视编辑视图即画布模块，自带<strong>主页 / 数据 / 画布 / 帮助</strong>四个子标签）：画布页摆节点连线，数据页按列配置表单录入，主页页看图表看板。',
          '<strong>在哪管</strong>：改动约 1.5 秒防抖<strong>自动保存</strong>回它自己的 <code>.data</code> 文件（工具栏 💾 可立即保存）；源码编辑视图里看到的是 JSON，可以直接改。'
        ]
      }
    },
    plugins: {
      overview: {
        title: '什么是插件？',
        desc: '插件是给软件本身增加能力的扩展包：既能给智能体<strong>加工具</strong>，也能往界面<strong>加主面板 / 设置页签 / 设置卡片</strong>、注册<strong>全局快捷键</strong>与中英文案，用来把自己写的脚本 / 团队内部工具接进 AI-KM。入口在<strong>设置 → 插件</strong>，分<strong>管理 / 商店 / 开发</strong>三个页签。'
      },
      capabilities: {
        title: '插件能做什么',
        items: [
          '<strong>加工具</strong>：插件注册的工具会自动加入智能体的可用工具集（在预设「工具」页可按需关闭；停用插件后工具立即消失），不会与内置工具重名。',
          '<strong>加界面</strong>：主面板（与主页 / 知识管理一样出现在导航栏）、设置页签、设置卡片，以及集群工作台页签；停用 / 卸载后立即消失，正停在插件面板上时会自动切回主页。',
          '<strong>调宿主能力</strong>：<code>ctx.llm</code> 按来源 / 模型发起对话、<code>ctx.files</code> 选文件 / 读文本 / 读表格 / 读二进制 / 用内置查看器打开、<code>ctx.app.agentPresets()</code> 读取 Agent 预设清单等。',
          '<strong>其它</strong>：注册全局快捷键（输入框内不触发）、提供中英文案字典、主动弹通知，以及读写自己的配置。'
        ]
      },
      manage: {
        title: '安装与管理（设置 → 插件 → 管理）',
        overview: '插件包就是一个文件夹：<code>package.json</code> 里带 <code>aikm</code> 清单字段。放进插件目录即被发现——新写的插件约 1 秒内自动装载，不必重启。',
        items: [
          { title: '放对位置', desc: '插件目录默认在用户数据目录下的 <code>plugins</code>，可点「选择插件目录」改到自己的文件夹；支持分文件夹存放（递归到第 4 层，跳过隐藏目录与 <code>node_modules</code>），也可以点 ➕ 从任意文件夹安装。' },
          { title: '目录名必须是合法插件 id', desc: '文件夹名要等于清单里的 <code>aikm.id</code>，且只能用 ASCII 小写 <code>[a-z0-9._-]</code>；带<strong>中文 / 大写 / 空格</strong>的文件夹会被宿主<strong>整目录跳过</strong>（不会出现在列表里），中文请写进清单的 <code>aikm.name</code>。' },
          { title: '启用前确认权限', desc: '启用 / 变更操作会先弹出确认框并列出该插件申请的权限；停用插件即收回它的一切能力。' },
          { title: '日常操作', desc: '启用 / 禁用 / 重载（先撤销旧注册再重新执行，改完界面代码不必重启）/ 日志 / 配置（传给插件的 JSON，保存后点重载生效）/ 详情 / 移除；「数据」按钮可查看并清理该插件的存储占用。' }
        ]
      },
      store: {
        title: '商店（从共享目录安装）',
        desc: '把<strong>设置 → 协作 → 共享</strong>里共享的文件夹直接当插件来源：粘贴 <code>remote-fs://…</code> 地址（或点「本机共享目录」），商店会自动扫描出其中的插件与技能并支持一键安装，安装前会列出该插件申请的权限。把插件文件夹放进共享目录即可发布，<strong>不需要手写索引文件</strong>。'
      },
      dev: {
        title: '开发（写插件的起点）',
        desc: '不需要先读源码：把<strong>设置 → 插件 → 开发</strong>页里的「通用开发指令」整段复制给任意大模型，写清你要的功能，它产出的文件放进插件目录就能启用。也可以直接在聊天里选<strong>插件开发智能体</strong>——它已绑定内置 MCP 服务 <code>builtin-plugin-dev</code>，能按需取回官方参考，并在交付前用宿主的真实加载状态自检。',
        items: [
          '页面提供：如何使用插件（安装 → 启用确认权限 → 面板 / 工具 / 快捷键在哪看 → 配置 → 排障 → 卸载，可一键复制）、从零开始的最小插件、可复制的指令模板（界面插件 / 工具插件 / 大模型与文件能力 / 排障指令）、清单与槽位 / API 速查表、常见问题（装载失败、槽位未声明、深色主题白底白字等）。',
          '仓库 <code>examples/plugins/hello-panel</code> 是可直接复制的示例插件（工具 + 界面 + 快捷键 + 双语示例）。'
        ]
      },
      perms: {
        title: '权限与安全',
        items: [
          '<code>fs</code> 文件读写（带此权限的插件工具默认需要审批）、<code>shell</code> 执行命令（仍受 trusted 策略约束）、<code>net</code> 网络请求、<code>agent</code> 只读会话日志、<code>llm</code> 调用你配置的来源与模型（会消耗额度 / 算力）；<strong>未申请的权限一律拒绝</strong>。',
          '单个插件的界面崩溃会就地显示「扩展出错了」+ 重试按钮，其余部分照常使用，不会连累主界面。'
        ],
        note: {
          title: '⚠️ 请只启用你信任的插件',
          text: '插件与主进程同进程运行（界面部分与主界面在同一页面），<strong>不受工作区沙箱保护</strong>：插件代码能做到宿主能做的任何事，权限声明只用于透明化与误操作防护。'
        }
      }
    },
    aiChat: {
      tasks: {
        title: '各模式适配的大致任务',
        normal: {
          items: [
            '日常问答：通识问题、概念解释、头脑风暴。',
            '写作与润色：改写、摘要、翻译、校对。',
            '文件参考：上传文件 / 图片（也可直接把文件拖进聊天窗口），让 AI 基于内容作答或总结。',
            '实时信息：切换到联网搜索模型时自动搜索并给出可点击来源。'
          ]
        },
        retrieval: {
          items: [
            '事实查证：就自己的文档提问，答案可追溯到原文片段（参考切片 / 来源）。',
            '策略化检索：按需选择 相似度 / 文件增强 / 问题增强 / 本体增强 / 多跳 / 社区 / Agentic。',
            '跨文档任务：比较多份文档、汇总主题、查漏补缺。',
            '长文档问答：切片 + 向量化后，大文档也能精准定位作答。'
          ]
        },
        workflow: {
          items: [
            '批量重复任务：同一套“抓取 → 检索 → 分析 / 总结”流程反复跑。',
            '自动化：把人工步骤固化为流程图，一键执行、随时复用。',
            '数据处理：CSV / JSON 读取 → 结构化 → 推理填值 → 导出。',
            '组合能力：串联 文本 / 推理 / 知识库 / 代码 / 迭代聚合 等节点。'
          ]
        },
        agent: {
          items: [
            '任务执行：不只回答，还“动手”——读写文件、整理、生成产物。',
            '信息搜集：搜索 + 网页 + 知识库多来源，汇总成稿。',
            '调用技能 / MCP：输入 $技能名 或按能力描述完成领域任务。',
            '自主规划：拆解多步任务、失败重试，直到完成（任务清单可视化）。'
          ]
        },
        code: {
          items: [
            '多步组合：把“搜索 → 读取 → 循环处理 → 汇总”写成一段程序一次跑完，适合步骤多、需要循环/条件判断的任务。',
            '批量循环：对一批文件 / 网址 / 查询逐个处理（程序内 for 循环），比逐次工具调用少很多往返。',
            '数据处理：把工具返回的结果在程序里直接过滤、汇总、算统计后再返回。'
          ]
        },
        swarm: {
          items: [
            '多视角对比：让不同角色的成员就同一方案各自发表意见，横向权衡优劣。',
            '分工协作：勾选“检索员 / 分析师 / 审稿人”等成员，同一任务各司其职、互相补充。',
            '纵横辩论：需要权衡的决策类问题，让成员多轮互驳后由群主中立总结。',
            '点名追问：用 @成员名 只唤起某一位成员单独作答，适合对某个结果继续深挖。'
          ]
        }
      },
      concept: {
        title: '核心概念',
        lead: 'AI-KM 的智能对话建立在以下核心概念之上（每点一个能力维度）：',
        items: [
          '<strong>① 本地优先 · 多模型</strong>：默认本地运行、可离线使用，可在多家模型来源间切换。',
          '<strong>② 多种对话模式</strong>：普通 / 知识库 / 工作流 / 智能体 / 集群 五种入口，任务从“问答”延伸到“执行”与“多智能体协作”；智能体还可把<strong>呈现方式</strong>设为 PTC（程序化工具调用）做“一次写清”的多步组合。',
          '<strong>③ RAG 只是其一</strong>：知识库模式先检索你的文档再作答，并可选本体 / 问题增强 / 多跳 / 社区等策略，但并非全部能力。',
          '<strong>④ 工具与智能体</strong>：智能体可按需读写文件、搜索、浏览网页、访问知识库、调用技能与 MCP。',
          '<strong>⑤ 数据本地化</strong>：对话、.kb、.learning、.flow.yml 均存本地，隐私可控、可离线。'
        ]
      },
      schemes: {
        title: '五种对话模式',
        normal: { name: '普通对话', desc: '直接与 AI 交流，支持上传文件/图片作为参考（也可把文件直接拖进聊天窗口），适合日常提问与写作；选择联网搜索模型（如 DeepSeek）后提问可自动联网并列出来源。' },
        retrieval: { name: '知识库问答', desc: '关联 .kb 知识库，AI 基于你的文档精准回答（RAG），答案下方展示参考片段与相似度；可在输入框上方选择检索策略（相似度 / 文件增强 / 问题增强 / 本体增强 / 多跳 / 社区 / Agentic 等）；知识库模式下把 .kb 文件拖进聊天窗口即完成关联。' },
        workflow: { name: '工作流对话', desc: '关联 .flow.yml / .flow.yaml 工作流文件（用可视画布编排也请在知识管理里打开同一份文件，见「工作流」页签），输入起始文本触发自动化流程：各节点排成可展开的步骤卡片（图标 / 状态 / 参数 / 输出，样式与智能体模式一致），结束后给出最终输出。' },
        agent: { name: '智能体对话', desc: '在输入框选择「智能体」模式：可点 👤 选 Agent 预设，或以通用智能体对话。AI 自主规划并调用工具（读写文件 / 搜索 / 浏览网页 / 知识库检索 / 技能 / MCP 等）完成复杂任务；输入 $技能名 可直达技能；支持<strong>上传图片</strong>（多模态，需所选模型支持视觉）与文本附件。<strong>执行期间输入框不锁死</strong>：继续输入要求后按 Enter 即作为<strong>引导</strong>投递给它（不打断当前执行，智能体在下一个 step 带上）。<strong>PTC（程序化工具调用）</strong> 就是本模式的一种预设呈现方式：把预设的呈现方式设为 PTC（内置「PTC 智能体」已配好），模型不再逐个调用工具，而是写一段 TypeScript 程序经 <code>run_code</code> 组合调用工具，消息里以代码块展示程序、返回值、console 日志与<strong>程序内实际调用的工具</strong>；适合多步循环与批量处理，同样适用于工作流 / 集群 / 批量。' },
        swarm: { name: '集群对话', desc: '在输入框选择「集群」模式：勾选<strong>多个 Agent 预设</strong>作为成员，一次任务由多成员协作完成（全员响应 / 辩论 / 项目组），可用 <code>@成员名</code> 只点名某一位；成员回复与工具调用与智能体模式完全一致；运行中也可输入<strong>引导</strong>（Enter 发送，投递给正在发言的成员）。' }
      },
      guide: {
        title: '四步使用指南',
        step1: {
          title: '安装Ollama（推荐）',
          items: [
            '访问 <a href="https://ollama.com/" target="_blank">ollama.com</a>',
            '运行 <code>ollama serve</code>',
            '运行 <code>ollama pull qwen3</code>'
          ]
        },
        step2: {
          title: '创建聊天对话',
          items: ['点击"新建聊天"', '选择模型（如qwen3）', '开始对话，像微信一样简单']
        },
        step3: {
          title: '关联知识库',
          items: ['点击书本图标 📚', '选择.kb格式知识库', 'AI回答时会自动从知识库找资料']
        },
        step4: {
          title: '聊天导入知识库',
          items: [
            '点击聊天记录区域的 <strong>保存/导出</strong> 按钮',
            '选择保存为 Markdown 文件，自动存入知识管理模块目录',
            '在知识管理的 <strong>浏览</strong> 或 <strong>编辑</strong> 视图中打开，可继续编辑和整理' 
          ]
        }
      }
    },
    knowledge: {
      overview: {
        title: '什么是知识管理？',
        description: '知识管理模块（knowFile）是一个<strong>多视图桌面文件管理器</strong>，支持以多种形式浏览、编辑和组织你的本地文件。它提供了独立窗口式文件浏览、多视图切换和全文搜索等能力，帮助你高效管理知识资产。'
      },
      fileTypes: {
        title: '文件类型与视图',
        overview: '知识管理是软件的文件中心：左侧是文件树（可添加本地 / 远程工作区），右侧是当前视图，顶部工具栏统一管路径与搜索。文件分两类、视图共 11 种——这一节先认识它们，细节看各自的页签。',
        views: {
          title: '11 种视图',
          desc: '打开文件后有 <strong>浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示</strong>，另有 <strong>文件 / 图谱 / 看板 / 日历 / 地图 / 表格</strong> 六个全局视图（用顶部「视图选择」下拉切换，默认视图可在<strong>设置 → 功能 → 知识管理</strong>里改）。'
        },
        general: {
          title: '通用文件',
          desc: 'Markdown、Word、PDF、图片音视频、纯文本、Excel、本地网页，以及 Excalidraw 白板与 draw.io 图表——见<strong>「通用文件」</strong>页签。'
        },
        special: {
          title: '专属文件',
          desc: '<code>.kb</code> 知识库、<code>.flow.yml</code> 工作流、<code>.task</code> Agent脚手架、<code>.data</code> 数据画布——各有专属视图，见<strong>「专属文件」</strong>页签。'
        }
      },
      views: {
        title: '视图一览（11 种视图 + 5 种专用视图）',
        groupViews: '11 种视图',
        groupFileViews: '5 种专用视图（文件专属 / 特殊文件）',
        browse: { name: '浏览', desc: '统一预览视图（默认）：Markdown 会渲染公式、代码高亮、表格、图片、Mermaid 图表，以及内嵌的 draw.io 图表（![](图.drawio) 直接渲染成图并可点击打开编辑器，浏览 / 可视编辑 / 思维导图 / 演示四个视图都会渲染，多页图表逐页渲染、可用 #page=2 指定页）；Word、PDF、图片、音视频等也各有预览。底部状态栏还提供「智能操作」（与当前文档对话）与导出 Markdown / Word / PDF。' },
        edit: { name: '源码编辑', desc: 'Monaco 代码编辑器：直接改 Markdown 源码与 YAML 头，支持 AI 辅助与拖入图片 / 文件生成引用链接；代码与数据文件（.py、.json、.flow.yml 等）也在这里以文本方式打开。' },
        blockedit: { name: '可视编辑', desc: '块编辑（所见即所得）：按块编辑，输入 / 唤出块类型菜单（标题 / 列表 / 待办 / 表格 / 代码 / 公式等），块手柄菜单的「转换为」可把当前块换成其它类型，不懂 Markdown 语法也能排版；文中内嵌的 draw.io 图表（![](图.drawio)）会直接渲染成图。' },
        mindmap: { name: '思维导图', desc: '思维导图视图：按 Markdown 标题层级生成可缩放、可逐层折叠的导图（支持 LaTeX 公式渲染，独立成段的展示公式与带公式的正文段落都会成节点），节点文字宽度与展开层数可在状态栏调节；状态栏 ▶ 进入讲解模式后，可用 ← / → 或触屏左右滑动逐级下钻、回退；内嵌的 draw.io 图表（![](图.drawio)）会渲染成图片显示在节点里。' },
        files: { name: '文件', desc: '文件视图：网格 / 列表浏览当前目录（Ctrl+滚轮无级缩放图标，缩到最小即列表），支持多选、框选与键盘操作；音频 / 视频显示封面缩略图；状态栏可按 YAML 属性（含状态）筛选；右键菜单可打开 / 重命名 / 删除 / 复制 / 剪切 / 粘贴 / 在文件夹中显示 / 排序（名称 / 修改时间 / 大小 / 类型）/ 显示（文件名开关、宽高比），空白处右键还能排序、切换显示与新建 Markdown、Excalidraw、工作流等文件与文件夹。' },
        kanban: { name: '看板', desc: '看板任务管理：卡片 = 当前文件夹（顶部面包屑所指目录）里的一个 Markdown 文件，可按任意属性分列（默认 状态），点左下角状态栏的 + 打开新建面板（填名称即可，还可选择状态与开始 / 结束时间，三者都能留空，开始时间默认今天），新建后立刻出现在日历 / 甘特上、卡片拖到别的列即改该属性值、卡片显示起止时间且右侧日历图标（或右键「设置时间」）可设置开始 / 结束时间（时间文字本身不可点）且右键可设置颜色（预设色板随主题切换，浅色 / 深色主题各一套，也可用取色器自定义或清除）/ 重命名 / 归档 / 移入某个取值 / 删除；在别处改了文件的属性（表格视图、源码编辑、外部编辑器）后卡片会自动刷新；面板宽度放不下并排两列时列会自动改为上下摆放；状态栏的「筛选」按钮可按分组字段的取值多选筛选（每个取值带卡片数，取值多时自动换行并滚动），状态栏还可切换看板 / 列表、读取深度与「是否显示已归档」，并可在「状态分类」里编辑分类的顺序与图标（与日历共用）；只出现在文件里的取值会列在面板底部，可一键加入分类表参与排序' },
        graph: { name: '图谱', desc: '文件关联图谱：目录层级与文件引用关系一图看清（目录内文件增删改后自动刷新；点击节点高亮其关联节点，拖动节点可手动调整布局；双击节点打开文件，与文件树一致——一律独立窗口打开并统一调度特殊文件）' },
        calendar: { name: '日历', desc: '月视图 / 周视图 / 年视图 / 甘特图四合一：支持起止区间（跨天条目横跨每一天）、颜色与状态图标、内搜索、拖拽改期、日期格内新建（建在当前文件夹）；只显示 Markdown 文件，且仅 Markdown 可拖拽改期；条目上右键可 打开 / 重命名 / 设置时间 / 颜色（预设色板随主题切换，也可用取色器自定义或清除）/ 归档 / 复制文件路径 / 在文件夹中显示 / 删除（与看板卡片的菜单一致，弹出的日期列表里同样可用），状态栏的归档图标控制是否显示已归档条目（默认不显示）' },
        map: { name: '地图', desc: '按文件 YAML 里的 纬度 / 经度 属性在地图上打点（可一键只显示有经纬度的文件），点标记或右侧列表即可打开文件；地图不需要搜索，工具栏只显示路径。' },
        table: { name: '表格', desc: '一行 = 一个文件、一列 = 一个 YAML 属性的表格：默认只列 Markdown（可切「全部」，非 Markdown 整行只读），列按当前「深度」范围内的属性生成（改深度 / 换目录时列跟着变，不会留下整列空白的旧列；被收敛的属性可在「列」面板底部一键加回，面板「+」还能手动加列）；列头点击即排序（升 / 降 / 取消），列菜单可按取值筛选（含「未设置」）/ 指定编辑器类型 / 重命名属性 / 隐藏此列，列可拖拽换序与拖右边界调宽，列序 / 列宽 / 类型 / 排序 / 筛选都会记住；单元格按属性类型编辑（文本 / 数字 / 日期 / 日期时间 / 复选框 / 颜色 / 单选 / 标签，状态列直接用状态分类的取值与图标），支持方向键移动、Enter 编辑 / Esc 取消 / Delete 清空与整块粘贴 Excel 数据，行首勾选后可批量设置 / 删除属性或删除文件，行右键菜单可打开 / 进入文件夹 / 新窗口打开 / 在文件夹中显示 / 复制路径 / 新建同级 / 重命名 / 删除' },
        presentation: { name: '演示', desc: '把 Markdown 变成幻灯片：按 --- 或「智能切分」（依标题 / 空行自动分页并避开代码块）分页，支持目录 / 总览 / 全屏放映、自适应与 16:9 / 4:3 比例、6 种幻灯片主题；frontmatter 的 title / keywords / summary 会自动生成封面。图片按形状自动排版（与幻灯片同形就独占一页、竖图与文字左右并排、宽图上下排，多图自动选列数或一图一页），文字过多会自动分页并把字号调到刚好铺满整页，超长表格裁行并标注省略行数，`Ctrl + 滚轮` 可缩放查看单页细节；触屏上可左右滑动翻页。' },
        excalidraw: { name: '白板', desc: 'Excalidraw 无限画布绘图（.excalidraw 文件专属）：手绘风格图形 / 箭头 / 文字 / 自由笔，编辑后自动写回文件（Ctrl+S 立即保存），无需单独安装' },
        drawio: { name: '图表', desc: 'draw.io 图表绘图（.drawio / .dio 文件专属）：流程图 / 架构图 / UML / ER 图等；编辑器内置，无需单独安装 draw.io，也不联网' },
        flow: { name: '工作流', desc: '工作流文件（.flow.yml / .flow.yaml，文件专属视图）：文件内容是 Dify 应用 DSL，在浏览 / 可视编辑视图直接打开工作流编辑器编排、运行与查看运行日志；源码编辑视图看到的是 YAML 文本' },
        kb: { name: '知识库文件', desc: '知识库文件（.kb）：存放知识处理（RAG）切分好的知识块与索引，体积较大。双击不会进入文件视图，而是跳到「知识处理」加载该库，可检索、问答与重新切分' },
        task: { name: '脚手架', desc: '脚手架任务文件（.task，文件专属视图）：一个 .task = 一个独立任务，双击在独立窗口里打开脚手架画布（导入表格 / 执行 / 图谱 / 日志 / 结果都在里面），配置与结果都保存在该文件里；旧脚手架的 .task 打开时自动转换配置' }
      },
      features: {
        title: '核心功能',
        step1: { title: '📂 文件浏览', desc: '左侧文件树展示目录结构。展开 / 折叠点节点左侧的箭头（单击不再开合）；桌面版点击 / 双击文件一律在独立窗口打开（可同时开多个窗口并排对照），安卓 / 网页端则在主界面上方以浮层窗口打开（与设置同一思路；安卓上单击文件即打开、单击文件夹即进入）；双击文件夹只让右侧各视图（文件 / 看板 / 表格 / 图谱 / 地图 / 日历）定位到该目录。右键菜单按节点类型区分：文件上「打开」直接列出各视图、「操作」里是 打开所在位置 / 复制地址 / 系统打开；文件夹与空白处可在「新建」里建 文件夹 / Markdown / Excalidraw / draw.io / 工作流 / 数据画布 / 脚手架 / Word / Excel / PPT（Office 三种会写入一份空白文档骨架，建好即可打开编辑），并支持 复制 / 粘贴（剪贴板与「文件」视图共用）/ 重命名 / 删除。<br>细长窗口（高宽比超过 16:9，如手机竖屏）下不再左右分栏：文件树变成<strong>整屏抽屉</strong>（工具栏最左的开关打开、左上角 ← 收起，点文件夹 / 文件后自动收起），右侧视图始终占满整屏。' },
        step2: { title: '🔄 多视图切换', desc: '同一个文件可切换不同视图查看：浏览（渲染）、源码编辑、可视编辑（块编辑/所见即所得）、思维导图、演示；<strong>Word / Excel / PPT</strong> 额外提供「<strong>Office 编辑</strong>」（内嵌真实办公套件，可原地编辑并保存为标准 Office 文件，默认即用该视图打开）。你可以在设置中开启/关闭不需要的视图。' },
        step3: { title: '🔍 全文搜索', desc: '顶部搜索框支持按文件名和内容全文搜索，快速定位所需文件；结果双击在独立窗口打开，打开后搜索面板保持打开，可连续打开多个结果（按 Esc 或点右上角 ✕ 关闭）。' },
        step4: { title: '🏷️ 分类管理', desc: '支持按 YAML 属性（状态等）筛选文件、「看板」视图按属性分组并快速记录 / 拖拽改属性（卡片即 Markdown 文件）、「表格」视图按列查看与整理属性（排序 / 筛选 / 批量改值 / 整块粘贴，列按当前「深度」范围的属性生成）、日历视图的甘特模式跟踪项目进度、图谱展示文件关联关系，满足不同维度的管理需求。除「文件」视图外，日历 / 看板 / 表格 / 图谱 / 地图都跟随左侧当前目录取数据；它们与文件视图共用一条顶部工具栏（多视图并排时也只有一条）：最左侧的显示 / 隐藏左侧面板开关 + 视图选择 + 后退 / 前进 / 向上 / 刷新 + 可点击的路径面包屑 + 右侧搜索框（工具栏很窄时导航按钮与面包屑会自动收起，快捷键 Alt+← / Alt+→ / Backspace 仍可用），搜索框也是共用的，各视图语法一致（关键词匹配文件名 / 路径 / 属性值，另支持 状态:待办、优先级>2）；底部状态栏只放各视图自己的设置与计数。' }
      },
      smart: {
        title: '🧠 文档智能操作与导出 Word',
        overview: '浏览视图（Markdown / Word / 纯文本）的<strong>底部状态栏</strong>提供两个进阶能力：<strong>与当前文档智能对话</strong>，以及<strong>导出 Markdown / Word / PDF</strong>。',
        step1: {
          title: '与文档对话（智能操作）',
          desc: '点状态栏最右侧的 ✨ <strong>智能操作</strong> 图标，右侧弹出对话面板。提问前可勾选<strong>附带上下文</strong>：<strong>整篇（默认）</strong> / <strong>当前章节</strong> / <strong>选中文字</strong>，AI 只基于这些内容作答，避免答非所问；面板宽度可拖拽（约 260–640px），回答流式输出且可随时停止。'
        },
        step2: {
          title: '导出 Markdown / Word / PDF',
          desc: '点状态栏的 ⬇ <strong>导出文档</strong> 图标，菜单里有「导出 Markdown」「导出 Word」「导出 PDF」三项；<strong>导出 Markdown</strong> 同样会弹出<strong>另存为对话框</strong>（默认当前文件所在目录），导出后提示实际保存路径。'
        },
        step3: {
          title: '导出 Word 的另存为对话框',
          desc: '选「导出 Word」会弹出<strong>另存为对话框</strong>：<strong>导出样式</strong>可选 公文（GB/T 9704-2012，默认）/ 中文论文 / 英文论文（APA 7）/ <strong>自定义 .docx 模板</strong>，并可<strong>指定保存位置</strong>（默认当前文件所在目录）。数学公式、表格、图片、Mermaid 图、内嵌的 draw.io 图表会一并导出（公式优先转成 Word 原生可编辑公式）。'
        },
        step4: {
          title: '其他导出入口与默认样式',
          desc: '同一套 Word 导出也用于<strong>主页聊天</strong>（消息区右键 → 导出 → Word）与<strong>集群运行结果面板</strong>；默认模板与自定义样式文件在 <strong>设置 → 通用 → 其他 → Word 导出</strong> 中设置。'
        },
        note: {
          title: '📌 使用提示：',
          text: '附带上下文有<strong>约 12 万字符</strong>上限，超出时会在输入区与已发送气泡中<strong>明确提示已截断</strong>（不会静默丢弃）；PDF 的智能操作使用同一面板，可选附带「当前页文字 / 全文 / 当前页图片」。<br><strong>PDF 还支持翻译</strong>：选中文字后<strong>右键 → 翻译</strong>，或点右下角的<strong>翻译图标</strong>叠加中文译文（滚动 / 翻页到的页会自动继续翻译，整份文档要么每页都叠加、要么都不叠加）；译文按段落<strong>原地叠在原文位置</strong>（双栏论文按栏、表格按单元格，不遮挡旁边的栏），<strong>公式自动按 LaTeX 渲染</strong>（KaTeX），并还原原文的首行 / 悬挂缩进，译文较短时自动放开行距并上下居中填满原段落。译文语言跟随系统语言；再点图标整份切回原文，右键图标可指定翻译来源与模型（默认跟随系统默认来源），弹层里还有「清空译文缓存」。'
        }
      },
      openMode: {
        title: '🪟 文件打开方式（独立窗口）',
        overview: '知识管理里<strong>双击文件</strong>一律在<strong>独立窗口</strong>打开；原有的「窗口内打开」模式（主窗口标签栏、视图管理面板）已去掉：',
        newWindow: {
          name: '🪟 独立窗口打开',
          desc: '双击文件时在<strong>独立窗口</strong>中打开。窗口内可切换该文件类型支持的视图（如 Markdown 支持全部五种，CSV 只有浏览 + 源码编辑，工作流 / 数据画布 / 脚手架 / 图片 / 音视频 / PDF 固定单一视图，此时不显示视图下拉），窗口标题显示「文件名 - 视图」，<strong>鼠标悬停在标题栏文件名上会显示文件的绝对路径</strong>。没有正文的 Markdown（空文件，或只有 YAML 头、如看板新建的卡片）会<strong>默认打开「源码编辑」</strong>而不是空白的浏览视图。多个文件可同时在不同窗口中打开，<strong>并排对照</strong>互不影响主窗口。'
        },
        effect: {
          title: '🔧 对操作的影响',
          items: [
            '<strong>双击打开位置</strong>：一律在独立窗口打开；主窗口只负责全局视图（文件 / 图谱 / 看板 / 日历 / 地图 / 表格）',
            '<strong>标签栏</strong>：主窗口不再有标签栏，文件树面板顶部是「添加工作区 / 打开文件 / 搜索 / 创建文件」按钮组',
            '<strong>视图选择</strong>：主窗口在顶部工具栏（左侧折叠图标右侧）切换全局视图，文件窗口左上角切换该文件自己的视图',
            '<strong>多文件对比</strong>：把多个文件放在不同窗口并排查看，各窗口的视图互不影响'
          ]
        },
        note: {
          title: '📌 使用提示：',
          text: '以下操作始终不变：右键文件时「打开」直接列出各视图（浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示，按文件类型给出），打开文件所在位置 / 复制地址 / 系统打开在同级的「操作」里；知识库（.kb）文件一律跳转到知识处理（RAG）模块；脚手架（.task）一律在独立窗口里打开它的专属「脚手架」视图；本地网页（.html / .htm）一律用内置浏览器打开；远程文件单击仍是主窗口内的快速预览，双击才开独立窗口。'
        }
      },
      drawio: {
        title: '📐 draw.io 图表（.drawio / .dio）',
        overview: '知识管理内置 <strong>draw.io 图表编辑器</strong>（draw.io 官方 webapp 随软件打包，<strong>完全离线可用</strong>）：<code>.drawio</code> / <code>.dio</code> 文件（以及内容含 <code>&lt;mxfile&gt;</code> 的 <code>.xml</code>）在<strong>浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示</strong>任一视图中都会直接打开绘图画布，用来画流程图、架构图、泳道图、ER 图、UML 等，无需另外安装 draw.io 或联网。<br>另外，Markdown 里用 <code>![](图.drawio)</code> 引用图表时，<strong>浏览 / 可视编辑 / 思维导图 / 演示</strong>四个视图都会把图表直接画在正文里（点击图表即打开编辑器，并<strong>直接定位到所点的那一页</strong>）；多页图表会<strong>逐页依次内嵌</strong>（超过 10 页只渲染前 10 页并提示；导图节点里只放第一页），要只看某一页就写成 <code>![](图.drawio#page=2)</code>（也可用页名：<code>#page=页名</code>）。导出 Word / PDF 时图表同样会一并输出。',
        step1: {
          title: '创建与打开',
          desc: '文件树顶部 <strong>➕ 创建文件</strong> 弹窗中把类型切到 <strong>draw.io</strong>（自动写入空白图表框架），或在文件树上右键「<strong>新建 → draw.io</strong>」；双击 <code>.drawio</code> 文件即进入图表视图。'
        },
        step2: {
          title: '编辑与保存',
          desc: '画布与 draw.io 桌面版一致（左侧图形库、右侧格式面板、底部页签栏）。编辑<strong>不会自动写盘</strong>（右下角保存按钮会出现<strong>橙色小点</strong>表示有未保存的改动），点右下角 💾 或按 <code>Ctrl+S</code> 才写回原文件并提示；切标签 / 换主题 / 关窗口时会静默兵底保存，不会丢内容。保存后会通知其他窗口与预览刷新。'
        },
        step3: {
          title: '导出 / 另存为 / 打印',
          desc: '菜单「文件 → 导出为」支持 PNG / JPEG / SVG / XML 等格式，「下载」与「另存为到设备」已改为<strong>系统原生保存对话框</strong>，可自选位置（默认当前图表所在目录），不会静默丢进系统下载文件夹；<strong>「导出为 → PDF」与「文件 → 打印」走应用本地打印通道</strong>（离线可用，只输出当前页；打印会弹系统打印对话框）；「文件 → 保存为」可另存为新的 <code>.drawio</code>。'
        },
        step4: {
          title: '智能操作（AI 生成 / 调整 / 删除图形）',
          desc: '点右下角 ✨ <strong>智能操作</strong> 打开右侧 AI 面板，用自然语言描述需求（如「加一个三步审批流程：提交 → 审核 → 归档」）。AI 会先读取当前图表内容，再生成增量片段并<strong>直接在画布上预览</strong>（面板列出「新增 / 调整 / 删除」明细）：点「确认应用」才写入文件，点「取消」原样回退。既可<strong>新增</strong>图形与连线，也能<strong>调整</strong>已有图形的位置 / 尺寸 / 文字 / 颜色 / 层级 / 连线，或按 id <strong>删除</strong>已有单元。多页图表只作用于<strong>画布当前打开的那一页</strong>，预览与取消后仍停留在该页。'
        },
        step5: {
          title: '两种智能操作模式',
          desc: '输入框左侧的模式下拉：<strong>自动可调</strong>（默认，允许新增 + 调整 + 删除）/ <strong>仅新增</strong>（只添加新图形与连线，绝不改动已有内容，新图形会自动避让到空白区）。协同会话中只有主机能发起智能操作，插入后会向所有成员重新同步图表。'
        },
        step6: {
          title: '复制为图片（直接粘贴到 Word / PPT）',
          desc: '点右下角 📋 <strong>复制为图片</strong>（快捷键 <code>Ctrl+Alt+X</code>）把当前图表放进系统剪贴板：可选 <strong>高清 4×（默认）/ 标准 2× / 原始 1×</strong>，然后到 Word / PPT / 聊天窗口里 <code>Ctrl+V</code> 即可，<strong>不必先保存文件</strong>。图片是<strong>白底</strong>、按图表原始大小排版（高清不会撑满整页），粘贴后依然清晰；超大图表会自动降档避免卡死；只输出<strong>当前页</strong>，图里的图片与换行标签都按画布所见还原。'
        },
        note: {
          title: '📌 使用提示：',
          text: '图表运行时（约 60MB）由 <code>scripts/fetch-drawio-webapp.mjs</code> 获取并随应用打包。远程共享的 <code>.drawio</code> 文件、以及协同中的只读成员打开时为<strong>只读预览</strong>（显示锁形徽标），需要修改请先下载到本地。多页图表导出 PDF / 打印时只输出<strong>当前页</strong>。'
        }
      },
      collab: {
        title: '🤝 局域网协同编辑',
        overview: '在<strong>同一局域网</strong>内，多台电脑可以<strong>实时协同编辑</strong>同一个文件——支持 <strong>代码 / Markdown 编辑器</strong>、<strong>Excalidraw 白板</strong>与 <strong>draw.io 图表</strong>三种场景。基于 <strong>Yjs CRDT</strong> 与增量补丁（draw.io 使用官方 diffSync）技术实现元素级实时同步：一边编辑、另一边立即可见，并显示<strong>成员光标、名称徽标</strong>与成员列表。',
        step1: {
          title: '开启协作',
          desc: '进入 <strong>设置 → 协作 → 协同</strong>，打开「<strong>启用协作</strong>」开关，然后点击「<strong>启动协同服务</strong>」。可配置端口（默认 <code>3346</code>）、最大成员数、编辑权限与房间 Token。'
        },
        step2: {
          title: '共享文件 / 白板 / 图表',
          desc: '在代码编辑器底部的状态栏，或 <strong>Excalidraw 白板 / draw.io 图表右下角的协作按钮</strong>，点击「共享」生成一个加入地址（<code>ws://IP:端口/collab/房间号?token=…</code>）。复制该地址发给局域网内的其他成员。'
        },
        step3: {
          title: '加入会话',
          desc: '其他成员打开同一文件，点击协作按钮 → 「加入会话」，粘贴地址并填写昵称即可加入。加入后即可实时看到彼此的光标、名称徽标与编辑内容，并支持<strong>同步主机的视图位置与缩放</strong>。'
        },
        step4: {
          title: '权限与保存',
          desc: '权限模式有三种：<strong>开放</strong>（全员可编辑，默认）/ <strong>批准</strong>（只读成员可请求编辑权，由主机批准）/ <strong>只读</strong>（仅主机可编辑）。<strong>仅主机可保存到磁盘</strong>（自动保存间隔可配置），成员退出不丢失已同步内容。'
        },
        step5: {
          title: '图表协同（.drawio）',
          desc: 'draw.io 图表的协同走官方<strong>增量同步（diffSync）</strong>：每位成员的编辑只广播变更补丁，各方画布即时更新且不会相互覆盖；新成员加入时由主机现导一份权威图表内容作为同步基准，因此会话中<strong>只有主机可写盘</strong>、也只有主机能发起 AI 智能操作。图表协同<strong>不显示他人光标位置</strong>。'
        },
        note: {
          title: '📌 使用提示：',
          text: '协作需要所有成员处于同一局域网并能互通端口；首次使用请先在设置中启动协同服务。白板支持图片等嵌入内容实时同步，代码编辑器支持成员光标与选区高亮，draw.io 图表以增量补丁合并编辑（不显示他人光标位置）。'
        }
      },
      remoteFs: {
        title: '☁️ 远程文件共享（共享文件夹）',
        overview: '通过<strong>共享文件夹</strong>，可以把本机的一个文件夹<strong>只读共享</strong>给局域网内的其他电脑：对方在「知识管理 → 文件树」中添加为<strong>远程工作区</strong>（云朵图标，恒显示在所有本地工作区最下方），即可浏览、<strong>预览</strong>其中的文件——支持 <strong>Markdown / 文本 / PDF / 图片 / Word</strong>，下载后即可编辑。',
        step1: {
          title: '主机端共享',
          desc: '在 <strong>设置 → 协作 → 共享</strong> 中启动共享文件夹服务，选择共享目录，配置端口（默认 <code>3347</code>）与 Token，然后复制连接地址（<code>remote-fs://IP:端口?token=…</code>）发给局域网内的其他成员。'
        },
        step2: {
          title: '客户端添加远程工作区',
          desc: '在<strong>知识管理 → 文件树空白处右键 → 添加远程工作区</strong>，粘贴上面的链接（或分别填写主机、端口、Token），共享目录即合并进文件树（☁️ 云图标、最下方），可懒加载浏览其中的目录与文件。'
        },
        step3: {
          title: '预览与下载',
          desc: '远程文件为<strong>只读预览</strong>：Markdown / 文本直接阅读，<strong>PDF / 图片 / Word</strong> 在「浏览」视图内联预览——PDF 支持翻页缩放、图片支持缩放拖拽、Word（.docx）自动转 Markdown 渲染。需要编辑时点击顶部「<strong>下载到本地</strong>」保存到当前工作区后即可编辑。'
        },
        step4: {
          title: '刷新远程目录',
          desc: '每个远程工作区根节点<strong>最右侧有刷新按钮</strong>（🔄），点击后重新拉取服务端目录，及时看到主机端新增 / 修改 / 删除的文件变化。右键远程节点还可「预览 / 下载到本地工作区 / 删除远程工作区」。'
        },
        note: {
          title: '📌 使用提示：',
          text: '远程文件为<strong>只读</strong>，修改请先下载到本地工作区；删除远程工作区不会影响主机文件。主机端需保持共享服务运行，且各客户端处于同一局域网、能访问端口 3347。'
        }
      },
    },
    knowRAG: {
      overview: {
        title: '什么是知识处理？',
        description: '知识处理（knowRAG）把本地文档构建成<strong>可检索、可学习、可评测的知识库（RAG）</strong>，并<strong>跟随全局 AI 配置</strong>（支持 Ollama / LM Studio / OpenAI / DeepSeek / Anthropic / Google / Azure 等）。顶部按 问答 / 文件 / 切片 / 问题 / 百科 / 本体 / 测试 / 设置 八个标签页组织：选库与转换 → 切片与向量化 → 抽取实体（百科）/ 提取问题（问题）→ 策略化问答与自动化评测 → 保存为 .kb 供「学习」等复用。检索策略可在「策略配置」自定义（处理管线 + 检索管线，内置 相似度 / 文件增强 / 问题增强 / 本体增强 / 多跳 / 社区 / Agentic 等）。'
      },
      workflow: {
        title: '处理流程',
        step1: '文件：选库 / 转换',
        step2: '切片：切分 / 向量化',
        step3: '百科+问题：抽取实体 / 提取问题',
        step4: '问答：策略检索问答',
        step5: '测试：评测 / 保存 .kb'
      },
      views: {
        title: '功能视图',
        file: { title: '📁 文件视图', desc: '打开文件夹选择知识库根目录，左侧列出所有支持的文件（PDF、Word、Markdown 等），点击文件可在右侧预览内容。顶部状态条提示 PDF/Word 规范化（可一键转换为同名 .md）与文件变更统计；增量检测到「新增 / 修改 / 删除」时，对应文件名标色并带徽标，便于定位具体变更文件。左栏顶部还会列出<strong>缺失文件</strong>（知识库记录、但当前文件夹已没有，按同名匹配以兼容文件夹改名 / 移动），点 🗑 可清理它们的切片 / 问题 / 摘要（需确认；保存时不会自动删除）。' },
        slice: { title: '✂️ 切片视图', desc: '选择切片策略（默认 / 智能 / 语义），点击切分按钮将文档分割为文本片段，再点向量化按钮生成嵌入。也支持「增量更新」：检测到文件新增 / 修改 / 删除时，自动重切变更文件并同步文件摘要、本体、社区与报告（未变化切片复用向量，幂等）。问题提取请在「问题」标签进行。' },
        ontology: { title: '🕸️ 本体视图', desc: '以 D3.js 力导向图查看“实体 / 关系 / 切片 / 文件 / 问题”的知识图谱，点击节点可高亮联动查看详情与关联切片。提供 <strong>手动连线</strong>（⛓）：进入连线模式后依次点击两个<strong>概念节点</strong>，由大模型自动判定关系类型（仅概念 ↔ 概念；引导与结果提示显示在底部状态栏）。构建 / 清空本体已移至「百科」页。社区<strong>生成报告</strong>支持暂停 / 继续 / 停止：推理过程中按钮变为 ⏸，暂停后用 ⏵ 从断点继续，已生成的报告不会重算，进度显示在底部状态栏。' },
        card: { title: '🧊 百科视图', desc: '以卡片网格管理“实体 = 百科条目”。它是<strong>本体构建入口</strong>：▶ 开始抽取实体（从切片抽取实体 / 关系 / 描述，进度显示在底部状态栏）、↻ 继续（带断点时从断点恢复）、🗑 清空（删除全部实体即卡片及其关系，需确认）。支持搜索、手动添加实体、批量生成描述；点击卡片可查看详情、编辑描述与关联切片。' },
        qa: { title: '💬 问答系统', desc: '聊天面板在顶部下拉选择<strong>检索策略</strong>（内置：相似度 / 文件增强 / 问题增强 / 本体增强 / 多跳 / 社区 / Agentic 等，可在策略配置启停或自定义），并展示每次回答的佐证切片。可调匹配阈值、检索数量、余弦/BM25 混合权重等参数。若知识库尚未切片 / 向量化，直接提问会自动完成准备再检索。' },
        question: { title: '❓ 问题标签页', desc: '问题库入口：▶ 从切片提取「问题 + 答案」对（支持暂停 / 继续 / 停止，进度在底部状态栏；默认<strong>先推理、结束后统一补一次向量</strong>，避免 LM Studio 反复交替加载对话 / 嵌入模型，需要边推理边向量化可点 ⚡ 切换）；可手动添加、语义去重 / LLM 合并、Excel 导入导出、生成复合问题；⚖ 独立性评审可让大模型标出不能独立作答的问题（仅会话内，不合适计数显示在底部状态栏）；🗑 清空全部问题（需确认，切片与文件不受影响，测试页由问题库派生的用例一并清空）；列表每 40 条下滑加载。' },
        test: { title: '🧪 测试标签页', desc: '自动化评测：测试问题与参考答案来自「问题」页问题库（自动同步）；🔄 读取测试用例 可在设置中修改“测试用例上限”后按新上限重新派生问题；支持批量测试（当前 / 全部策略，均可在测试过程中<strong>暂停 / 继续 / 停止</strong>，停止后已测结果保留）、位次分析、导出 Excel。工具栏可直接选择<strong>评测用嵌入模型</strong>（来自当前模型来源，无需进入设置；选「跟随设置」即用设置里的嵌入模型，该选择随 .kb 保存，不改动设置值）。评测前若切片缺少向量（如精简模式保存的 .kb），会先自动补全向量再开测，避免总分显示为 0。工具栏 🔥 按钮打开<strong>「预热 / 向量缓存」浮层</strong>：一张表里逐项列出「批量生成摘要 + 摘要 / 切片 / 问题 / 实体向量缓存 + 社区报告」（勾选 / 状态 / 进度 / 耗时同列一处，不重复出现），勾选后执行。已有摘要（含 md 文件 frontmatter 里的「摘要」元信息）或向量会自动跳过、不重复生成，已就绪的项用主题色标出。工具栏数字框可设<strong>重复次数</strong>（仅「批量测试所有策略」生效）：同一批问题重复跑 N 轮，对比表各指标以<strong>均值 ± 标准差</strong>呈现；对比表另附<strong>成本列</strong>（模型调用 / 题、工具调用 / 题，悬停看工具分布）与<strong>配对显著性检验</strong>（选基线后给出命中差异的 McNemar p 与位次差异的 Wilcoxon p 及结论），均可导出 Excel。命中判定除「切片命中 / 答案命中」外，还可选<strong>「大模型判定」</strong>（仅智能路由类策略可用）：由对话模型对比检索片段与问题 / 参考答案，给出<strong>是否命中与最前命中位次</strong>（同义改写、答案分散也能判命中），判定调用计入「模型调用 / 题」成本、不计入检索时间，结果与理由可在「过程」里查看。智能路由的问题可在结果行点<strong>「过程」</strong>回看当次工具调用轨迹（轮次 / 工具 / 参数 / 返回）；在「设置 → 处理配置」勾选<strong>「保存测试结果到 KB 文件」</strong>后，这些结果随 .kb 落盘，重新加载即可查看 / 导出，无需重跑。' },
        settings: { title: '⚙️ 设置标签页', desc: '三类配置：知识库配置（.kb 管理）、策略配置（自定义检索策略，见下）、处理配置（切片策略、问题去重、测试用例上限、本体推理描述词与批量大小、是否把向量 / 测试结果写入 KB 文件等）。模型来源统一跟随全局 AI 配置。' }
      },
      qaModes: {
        title: '问答模式与内置策略',
        similarity: { name: '相似度', desc: '纯切片向量余弦相似度检索，速度快，适合单点精准查询。' },
        fileEnhance: { name: '文件增强', desc: '以文件级摘要分为主的检索：先跑纯切片基线，再用文件语义摘要分加权，适合文件级 / 跨文档主题问题。' },
        questionEnhance: { name: '问题增强', desc: '以问题库问题向量为增强通道（0.7 问题 + 0.3 切片，取每条关联问题与查询相似度的最大值），适合围绕“可回答知识点”的提问。' },
        ontology: { name: '本体增强', desc: '先用模糊匹配或 LLM 理解查询中的实体，再对相关切片做实体命中乘性增强，适合实体关系类问题。' },
        multiHop: { name: '多跳检索', desc: '以查询实体为起点，沿知识图谱 BFS 多跳扩展关联实体（最多 2 跳），聚合间接关联信息，适合多跳推理问题，并展示推理路径佐证。' },
        multiStage: { name: '社区检索', desc: 'GraphRAG 风格的 Map-Reduce：先运行社区检测生成社区报告，再并行分片总结、汇总出全局答案，适合"全局概览"类问题。' },
        agentic: { name: 'Agentic 检索', desc: 'LLM 自主多轮检索：由大模型决定检索词，通过 kb_search 工具反复检索直到资料充分（佐证自动去重），适合复杂开放性问题。' },
        note: {
          title: '📌 使用提示：',
          text: '相似度、文件增强无需本体；本体增强、多跳需要先构建本体；社区还需社区检测；问题增强以问题库问题向量为增强通道（跑其处理管线会自动补全问题向量）。知识库未切片 / 向量化时，直接提问会自动构建并检索。右侧“佐证”面板展示每种策略的依据切片或推理路径。以上只是默认内置策略，可在「知识库 → 设置 → 策略配置」自定义（处理管线 / 检索管线，检索管线含“问题增强通道”开关），问答下拉即显示当前启用的全部策略。'
        }
      },
      config: {
        title: '配置说明',
        description: '知识处理全程使用<strong>全局 AI 配置</strong>的模型（设置 → 模型 → 来源中选择的 AI 来源与模型），无需在此单独配置来源。嵌入、对话、处理模型分别默认取该来源的默认嵌入模型与主模型；嵌入模型可在知识库「设置」中调整。支持多种检索算法：余弦相似度、BM25 及混合检索，检索数量可选按数量 / 按匹配率 / 按字符；检索策略可在「策略配置」中自定义（见下）。'
      },
      strategies: {
        title: '自定义检索策略（处理管线）',
        intro: '知识库的问答与测试不再局限于固定模式，可在「知识库 → 设置 → <strong>策略配置</strong>」中自定义检索策略：选择策略类型、编排「处理管线」与「检索管线」的原语组合并调参，问答下拉与自动化测试即按该策略执行。',
        kinds: {
          title: '四种策略类型',
          pipeline: { name: '管线组合', desc: '最灵活：自行编排「处理管线」（构建阶段）与「检索管线」（查询阶段）的原语步骤；每个步骤可选原语、模式（设置基础分 / 乘性提升 / 加权融合 / 取最大）与参数。' },
          mapreduce: { name: '社区全局', desc: 'GraphRAG 风格 Map-Reduce：先按社区生成报告，再并行分片总结、汇总出全局答案，适合“全局概览”类问题。' },
          agentic: { name: '智能路由', desc: '由大模型自主多轮检索：可开关 kb_search / file_search / entity_link / entity_slice / graph_hop / community_search 等检索工具，模型自行决定检索路径；<strong>系统提示词可自定义</strong>（留空=内置默认提示词，按界面语言自动选择），未构建数据的工具不会暴露给模型，最终位次由代码确定性排序（切片级证据优先 + 工具通道分与原始问题对齐加权融合），不由模型排序。' },
          hybrid: { name: '多路混合', desc: '同时启用多个确定性召回通道（稠密 / 稀疏 / 本体 / 图谱 / 社区），再统一排序（余弦重排或 RRF 排名融合）取 TopK。' }
        },
        pipeline: {
          title: '处理管线 vs 检索管线',
          ingest: '<strong>处理管线（构造管线，构建阶段）</strong>：在切片 / 向量化 / 增量更新时执行，负责构建知识库的增强能力——产出语义向量、本体、社区与报告，供查询阶段消费；已处理的数据自动跳过（幂等）。包含五类处理原语：<strong>问题语义增强</strong>（为问题库补全问题向量，“问题增强”策略的依赖处理管线）、<strong>文件语义增强</strong>（文件 → 摘要向量）、<strong>本体推理</strong>（切片 → 实体/关系）、<strong>社区检测</strong>（实体图 → 社区）、<strong>报告生成</strong>（社区 → 报告）。',
          retrieve: '<strong>检索管线（查询阶段）</strong>：每次提问按编排顺序执行的原语链，例如「稠密召回 → BM25 → 实体链接 → 图谱多跳 → 社区筛选 → 加权融合」，决定知识如何被召回与打分；内置策略缺失的处理原语会提示一键补齐。'
        },
        params: {
          title: '检索参数',
          desc: '每个策略可独立配置召回数量（TopK）、检索模式（按数量 / 按匹配率 / 按字符）、匹配率阈值、字符限制、BM25 开关与权重等；问答与测试即用当前选中策略的参数执行，并支持启用 / 停用 / 恢复默认。智能路由（Agentic）另有四个专属项：<strong>最大步数</strong>（工具循环上限）、<strong>工具候选数</strong>（每个工具内部取多少条候选，全部并入证据池参与最终排序以抬高召回上限；留空=跟随处理配置）、<strong>重排权重</strong>（融合工具通道分与原始问题内容余弦，留空=跟随处理配置）、<strong>暖启动</strong>与<strong>自动补检索</strong>开关（关闭后者即「纯 LLM 路由」，可做消融）。注意「召回数量」是评测取用与呈现的条数（也是测试页的 K），并不限制「工具候选数」。'
        }
      }
    },
    workflow: {
      usage: {
        title: '📂 打开与保存（知识管理里的 .flow.yml）',
        items: [
          '入口：工作流是<strong>知识管理里的一种文件类型</strong>——打开 <code>.flow.yml</code> / <code>.flow.yaml</code> 文件即进入画布；新建时在「工作流」类型里创建',
          '格式：文件内容就是<strong>Dify 应用 DSL（YAML）</strong>，可被 Dify 直接导入；打开 Dify 导出的应用文件时，未识别的节点类型会原样保留并给出提示',
          '画布操作：左键拖动节点、从节点右侧端口拖出连线、右键在画布空白或节点上添加节点、<code>Ctrl+D</code> 复制、<code>Del</code> 删除选中；连线会自动阻止自连 / 重复 / 成环',
          '底部状态栏：左下角是 添加节点 / 自动布局 / 运行 / 应用设置 / <strong>AI 编排</strong> / 删除选中 / 保存，右下角是 节点 · 连线数量 / 缩小 / 缩放百分比 / 放大 / 适应画布 / <strong>锁定画布</strong>（防误拖） / <strong>小地图开关</strong>，<code>Ctrl+S</code> 保存',
          'AI 编排：点左下角 ✨ 打开面板，用自然语言描述需求（如「加一个条件分支」），模型会生成 / 改写整份工作流并可直接撤销；面板样式与运行面板一致',
          '容器（迭代 / 循环）：把节点拖进容器框内即成为子节点，容器右下角可拖拽调整大小（自动布局不会缩回去）；容器内部连线与容器出口都正常显示',
          '外观：画布跟随「设置 → 界面」的主题（深色 / 浅色与全部皮肤）自动适配；节点卡片第二行显示该节点的关键配置（模型、输入 / 输出变量、迭代变量、文件等）',
          '右侧面板按需出现：选中节点显示<strong>属性面板</strong>，点「运行」显示<strong>运行面板</strong>（点它右上角 ✕ 关闭），两者不同时显示',
          '保存：工具栏「保存」写回文件；属性面板里的改动会即时把文件标记为未保存（工具栏出现 ●）'
        ]
      },
      nodes: {
        title: '节点类型',
        start: { name: '开始', desc: '工作流入口，定义输入变量' },
        end: { name: '结束', desc: '声明最终输出变量' },
        answer: { name: '直接回复', desc: '把正文作为回复内容' },
        llm: { name: '大语言模型', desc: '调用模型，配置提示词与上下文' },
        agent: { name: '智能体', desc: '交给所选智能体预设自主完成任务（自主规划 + 工具调用 + 技能 / 知识库 / MCP），输出 text / files / json' },
        ifElse: { name: '条件分支', desc: '按条件分流，不命中走 ELSE' },
        classifier: { name: '问题分类器', desc: '让模型把输入归到某个分类分支' },
        iteration: { name: '迭代', desc: '把数组逐项送进容器处理，结果收成数组' },
        loop: { name: '循环', desc: '按轮次重复容器内节点，可设结束条件' },
        code: { name: '代码执行', desc: '运行 Python 3；定义 main 时自动调用并取返回值（Dify 写法），否则输出 JSON 即输出变量' },
        template: { name: '模板转换', desc: '用变量填充模板文本' },
        http: { name: 'HTTP 请求', desc: '调用外部接口，地址与参数支持变量' },
        tool: { name: '工具', desc: '通过 MCP 调用外部工具' },
        knowledge: { name: '知识检索', desc: '从知识库检索相关片段' },
        aggregator: { name: '变量聚合', desc: '取第一个有值的变量' },
        assigner: { name: '变量赋值', desc: '写入会话变量或循环变量' },
        listOp: { name: '列表操作', desc: '过滤 / 排序 / 提取字段 / 截断' },
        paramExtract: { name: '参数提取器', desc: '让模型抽取结构化参数' },
        extractor: { name: '文档提取器', desc: '读取文件内容为文本' },
        word: { name: '导出 Word', desc: '把上游内容导出为 .docx（本地扩展）' },
        csv: { name: '本地数据表', desc: '读取 CSV / TSV / Excel，可分批（本地扩展）' },
        localFile: { name: '本地文件', desc: '读取文件，支持模板切片（本地扩展）' },
        localKb: { name: '本地知识库', desc: '检索本地 .kb 知识库（本地扩展）' },
        mcp: { name: 'MCP 工具', desc: '内联或引用设置里的 MCP 服务（本地扩展）' },
        subflow: { name: '子工作流', desc: '调用另一个工作流文件（本地扩展）' }
      },
      variables: {
        title: '🔗 变量、分支与容器',
        items: [
          '取值一律用<strong>变量选择器</strong>（不写死节点名）：按「上游节点输出 / 系统变量 / 环境变量 / 会话变量」分组选择，改名不会断链',
          '在文本里引用变量：提示词、回复正文等可写 <code>{{#节点.变量#}}</code>，用选择器的「插入变量」直接插到光标处',
          '<strong>分支节点</strong>（条件分支 / 问题分类器）每个分支出一个端口，运行时只走命中的那一支，其余分支标记为「已跳过」',
          '<strong>容器节点</strong>（迭代 / 循环）：把节点拖进容器框内即成为子节点，入口节点提供 <code>item</code> 与 <code>index</code>；循环可用「变量赋值」更新循环变量'
        ]
      },
      run: {
        title: '▶️ 运行与设置',
        items: [
          '运行：工具栏「运行」→ 填写开始节点声明的输入变量 → 开始运行；运行中可随时中止',
          '画布反馈：节点右上角圆点表示状态（蓝=运行中 / 绿=成功 / 红=失败 / 灰=跳过）；右侧运行面板给出<strong>追踪树</strong>（容器子节点缩进）、每节点耗时、日志与流式输出',
          '运行历史：面板顶部可切换最近 5 次运行，便于对比',
          '调试：选中节点后可「试跑此节点」或「运行此节点及下游」，上游不重跑；运行面板的<strong>变量</strong>区列出各节点产出的变量，可直接改值后单独重跑某个节点（改了的值会标记「已改」，可单项或整体恢复）',
          '应用设置：工具栏「应用设置」可改应用名称 / 图标 / 应用模式、开场白与推荐问题、文件上传等功能开关，以及全局的<strong>环境变量</strong>与<strong>会话变量</strong>',
          '异常处理：每个节点可选「出错即终止 / 忽略错误继续 / 移除异常输出 / 走异常分支」，大语言模型 / 智能体 / HTTP 请求 / 代码 / 工具节点还可选「失败用<strong>默认值</strong>继续」（按输出变量名填 JSON 对象），并可开启失败重试（支持指数退避）'
        ]
      },
      example: {
        title: '示例：从问题到 Word 报告',
        step1: {
          title: '拖出四个节点：',
          tags: ['▶️ 开始', '🤖 大语言模型', '🔀 条件分支', '📄 导出 Word']
        },
        step2: {
          title: '连线并填变量：',
          description: '从节点右侧端口拖到下一个节点；在「结束」或「导出 Word」里用变量选择器取上游输出',
          flow: '开始(question) → 大语言模型 → 条件分支 → 导出 Word'
        },
        step3: {
          title: '配置并运行：',
          items: [
            '开始：定义输入变量 question',
            '大语言模型：选模型来源与模型，提示词里插入 {{#开始.question#}}',
            '条件分支：给分支配条件（例如内容长度 > 100）',
            '导出 Word：内容变量选大语言模型的 text，选模板与保存目录',
            '点工具栏「运行」，填 question 后开始；运行面板里看每个节点的耗时与输出'
          ]
        }
      }
    },
    settings: {
      overview: {
        title: '设置总览',
        description: '所有应用配置集中在 <strong>设置</strong> 面板，左侧为二级导航：<strong>通用</strong>（基础 / 模型 / 凭据 / 关联 / 其他）、<strong>协作</strong>（共享 / 协同 / 权限）、<strong>语音</strong>（合成 / 输入）、<strong>工具</strong>（管理 / 搜索 / MCP / 注册表）、<strong>插件</strong>（管理 / 商店 / 开发）、<strong>技能</strong>（管理 / 商店）、<strong>智能体</strong>（预设 / 控制台 / 日志）、<strong>帮助</strong>。点左侧项即进入对应面板；其中的「模型」等全局配置对主页、知识处理、语音等模块统一生效。<br>细长窗口（高宽比超过 16:9，如手机竖屏）下导航与内容各占满整屏互相切换（分类列表是钢琴键式条目，左上角 ← 返回分类）；设置内部的列表型面板——模型来源、搜索源、MCP、插件管理、技能管理 / 商店、智能体预设 / 控制台 / 日志——同样是「整屏列表 ⇄ 整屏内容」两屏；技能管理与技能商店内容更多，会逐级整屏下钻（技能列表 → 文件树 → 文件编辑，商店：技能网格 ⇄ 来源列表 ⇄ 技能详情），每屏左上角 ← 回到上一级。'
      },
      groups: {
        basic: {
          title: '🧭 通用',
          items: {
            view: { name: '基础', desc: '语言 / 主题 / 窗口缩放 / <strong>文字对齐</strong>（两端对齐 / K-P 最优断行）/ <strong>关闭按钮行为</strong> / <strong>配置随软件分发</strong>，以及路径与常用操作。' },
            features: { name: '功能', desc: '主界面导航栏的入口开关（顶层模块：主页 / 知识管理 / 知识处理 / 学习，以及<strong>浏览器 Agent</strong> 的地球图标——关掉后导航栏不再显示它，AI 与知识管理面板仍可打开浏览器），以及知识管理主窗口右侧显示的<strong>视图</strong>（文件 / 看板 / 表格 / 图谱 / 地图 / 日历，单选一次只显示一个；预览远程文件时自动切到「浏览」）。' },
            data: { name: '数据', desc: '本机数据总览：本地存储占用、数据目录（可打开所在文件夹）与可清理缓存，<strong>配置备份</strong>可一键导出 / 导入全部配置；数据清单逐类列出聊天记录 / 旧版待办与随手记 / Agent 预设 / MCP / 会话日志 / 配置的数量与占用，每类可导出 / 导入（会话日志可清空或打开所在文件夹），并可直接前往对应设置页。只统计本机数据，工作区里的知识库、工作流、数据画布等文件不算在内（请在「知识管理」查看）。' },
            fileassoc: { name: '关联', desc: '按文件类型设置系统默认打开方式，可一键设置 / 全部取消。' },
            other: { name: '其他', desc: '系统状态（Python 检测与<strong>安全策略</strong>：只读安全 / 工作区写入 / 完全访问三档，决定智能体执行代码、命令与联网的权限，改完对所有窗口立即生效并保留）、浏览器、Word 导出与离线地图包（MBTiles）。' }
          }
        },
        models: {
          title: '🧠 模型',
          items: {
            llm: { name: '来源', desc: '各 AI 来源的连接配置（地址 / 密钥 / 模型 / 接口样式 / 默认嵌入模型）、<strong>通用参数</strong>（温度 / 最大令牌 / 流式 / 推理强度）与<strong>上下文窗口</strong>（见下方专述）。左侧列表可点选查看任意来源，<strong>点「设为默认」才改变默认来源</strong>。' },
            'llm-embed': { name: '嵌入', desc: '<strong>嵌入兜底</strong>：当前来源不提供嵌入接口（如 DeepSeek / Anthropic）时，知识库建库与检索的向量化改用这里选的来源。' },
            credentials: { name: '凭据', desc: 'API Key 表格化管理，明文只存主进程，可被各来源的「凭据引用」使用。' }
          }
        },
        collabGroup: {
          title: '🤝 协作',
          items: {
            share: { name: '共享', desc: '局域网共享（网页端入口 / 端口 / 知识库目录）与共享文件夹（远程只读文件服务，端口 / 目录 / Token）。' },
            collab: { name: '协同', desc: '协同文件编辑：端口 / 成员上限 / 编辑权限（开放·批准·只读）/ 房间 Token。' },
            perm: { name: '权限', desc: '<strong>局域网访客白名单</strong>：允许的对话模式（默认仅普通 + 知识库）、<strong>可用智能体</strong>（通用智能体固定开放，可选开放 Agent 预设）、智能体工具（默认只读，技能由 <code>skill</code> 工具控制）、<strong>访客用的模型来源与模型</strong>（默认跟随主机当前来源）、并发与步数、<strong>文件访问</strong>（默认关闭；只读可浏览 / 预览 / 检索，可写另可新建 / 保存 / 删除，均限制在「共享」页设置的共享目录内）、沙箱级别与访问令牌（默认不需要）；网页端智能体由主机执行。' }
          }
        },
        speech: {
          title: '🗣️ 语音',
          items: {
            tts: { name: '合成', desc: '语音合成：音色 / 语速 / 引擎（含本地 Kokoro / Piper）。' },
            asr: { name: '输入', desc: '语音识别：本地 ONNX Whisper 或服务端引擎（Whisper API / Qwen3-ASR 网页服务），可自动断句。' }
          }
        },
        tools: {
          title: '🧰 工具',
          items: {
            tools: { name: '管理', desc: '逐工具开关：启用状态、沙箱偏好与审批要求（共 18 个）。' },
            search: { name: '搜索', desc: '联网搜索源：Bing / 百度 / DuckDuckGo / SearXNG / 博查 / 智谱 / Tavily / Brave，可同时启用多个并选回退 / 聚合策略，也可添加自定义（内网）源。' },
            mcp: { name: 'MCP', desc: 'MCP 服务增删启停，预置 <strong>6 个内置服务</strong>（见下方专述）。' },
            toolregistry: { name: '注册表', desc: '只读查看主进程已注册的工具及其白名单状态。' }
          }
        },
        plugin: {
          title: '🔌 插件',
          items: {
            plugin: { name: '管理', desc: '本地插件（工具 / 界面扩展）的发现、启用停用、重载、日志、配置、详情与移除，行内动作都是图标按钮（悬停看说明）；标题栏下方的<strong>搜索框</strong>可按名称 / 插件 id / 文件夹 / 权限 / 工具 / 服务 / 描述 / 状态过滤列表（计数显示「匹配数 / 总数」），标题旁的 ⚠️ 图标悬停可看<strong>安全提示</strong>。插件既能给智能体加工具，也能加界面——主面板（自动出现在导航栏）、设置页签、设置卡片、集群工作台页签，还能注册全局快捷键、提供中英文案；本版新增两类宿主能力：<strong>调用大模型</strong>（可选来源与模型，权限 <code>llm</code>）与<strong>文件能力</strong>（选文件 / 选文件夹 / 列目录 / 读文本 / <strong>读表格 <code>readSheet</code></strong>（.xlsx/.xls/.csv，界面半边没有 SheetJS，插件读表用它）/ <strong>读二进制</strong> <code>readBase64</code> / PDF 文本提取与<strong>页面预览</strong>，权限 <code>fs</code>，且只能访问你在该插件里亲自选过的路径，<strong>选过一次就会记住（重启软件后不用重选）</strong>，可在「数据 → 文件授权」里逐条或一键撤销，卸载插件会一并清掉），另有只读的应用信息（预设智能体清单）与<strong>语音朗读</strong>（把一段文本交给应用自带 TTS 念出来，引擎与音色跟随「设置 → 语音」，无需权限）。可从文件夹安装插件包（<code>package.json</code> + <code>aikm</code> 清单），移除时可选择连磁盘文件一起删除；插件目录默认 <code>userData/plugins</code>，也可像技能那样指定到自己的文件夹。<strong>插件可以分文件夹存放</strong>：直接放在插件目录下、或按用途放进各级子文件夹都行（会扫描到第 4 层，插件自己的 <code>node_modules</code> / 隐藏目录不会被误认），列表里每个插件都标出它属于哪个文件夹；<strong>新写的插件会自动发现</strong>（约 1 秒内装载并出现在界面上，不必重启，也不必手动扫描），手动点目录栏的<strong>重新扫描</strong>（🔍+）可作为兜底。每个插件还有<strong>数据</strong>管理（🗄️ 图标）：能看到它占用了多少（设置存 localStorage、存档等大文件存本机 OPFS 的 <code>plugins/&lt;插件 id&gt;/</code>、插件私有数据存主进程的 <code>plugins-data/&lt;插件 id&gt;/</code>），列出每一项明细并可逐项或一键清除，占用不为零时列表里会直接显示大小。<strong>点「重新载入」会连界面半边一起重载</strong>（改完插件的界面代码不必重启软件）；界面半边装载失败时，插件卡片上会直接标出「界面半边装载失败」并给出原因，点「重新载入」即可重试。插件与主进程同进程运行、<strong>不受工作区沙箱保护</strong>，启用前会先列出它申请的权限并要求确认。' },
            'plugin-store': { name: '商店', desc: '把<strong>共享目录</strong>当成插件来源：粘贴「协作 → 共享」里那条 <code>remote-fs://ip:port?token=…</code> 地址（或点「本机共享目录」）即可浏览其中的插件并一键安装，无需新协议——共享服务本来就是只读 + 令牌的 HTTP 服务，商店清单由它实时扫描生成（把插件 / 技能文件夹放进共享目录、可分类放子文件夹，不用手写索引文件）。安装前会列出该插件申请的权限并要求确认，装好后可在「管理」里启用 / 重载 / 卸载；同一地址也能加成技能商店的来源。' },
            'plugin-dev': { name: '开发', desc: '写插件的地方：可以把「通用开发指令」整段复制给任意大模型（产出的文件放进插件目录就能启用），也可以<strong>直接在对话里选「插件开发智能体」</strong>——它已绑定内置 MCP 服务 <code>builtin-plugin-dev</code>（6 个短工具：<code>plugin_dev_host</code> / <code>plugin_dev_constraints</code> / <code>plugin_dev_manifest</code> / <code>plugin_dev_api</code> / <code>plugin_dev_faq</code> / <code>plugin_dev_templates</code>），能按需分批拿到这份官方参考（约束 / 清单字段 / 槽位 / 宿主 API / 最小示例）与本机插件目录路径，不需要你手动粘贴，也不会去磁盘上找软件源码。<strong>插件文件夹命名规则在开发指令、模板、硬约束与本 MCP 服务里都会先说明</strong>：文件夹名必须等于清单 <code>aikm.id</code>，且只能用 ASCII 小写 <code>[a-z0-9._-]</code>；带中文 / 大写 / 空格的目录名会被宿主整目录跳过（列表里不出现，管理页会提示），中文写进 <code>aikm.name</code> 与界面文案。页内还有<strong>界面插件 / 设置页签与设置卡片 / 图表 / 工具插件 / 大模型与文件能力</strong>等多个模板（设置页签那节还给了可用的设置分组 id 与设置页 id 清单——分组写错会多出一个同名的「插件」一级菜单）、<strong>排障指令</strong>（把「插件 → 管理 → 日志」里的报错一起粘给模型让它改）、从零开始的最小可运行示例、清单 / 槽位 / API 速查表，以及「如何使用插件」的完整步骤（安装 → 启用确认权限 → 面板 / 工具 / 快捷键在哪看 → 配置 → 排障 → 卸载）。' }
          }
        },
        skills: {
          title: '🧩 技能',
          items: {
            manage: { name: '管理', desc: '技能文件管理：启用 / 停用、编辑（对话中用 $技能名 触发）。' },
            store: { name: '商店', desc: '从 GitHub 等远程源搜索技能并一键下载安装。' }
          }
        },
        agent: {
          title: '🤖 智能体',
          items: {
            presets: { name: '预设', desc: '角色 / 模型 / 系统提示与逐工具能力，对话中点 👤 使用；内置「通用智能体」「代码智能体」「办公智能体」「PTC 智能体」「插件开发智能体」与「Pi 智能体」「DSH 智能体」「Codex 智能体」八个预设，开箱可用、可编辑，但不可删除（后三个对照开源 harness 的提示词结构与工具编排：Pi 极简、不设计划与子智能体；DSH 用<strong>指令段</strong>组装人格与能力并带运行护栏；Codex 按只读 / 工作区写入 / 完全访问三档沙箱描述行动边界）。<strong>改坏了不用担心</strong>：内置预设的配置页标签栏最右侧有「恢复默认」，确认后即可把名称 / 模型 / 系统提示 / 工具 / 技能 / MCP / 指令段整体还原成出厂值（用户自建预设不显示该按钮）。「工具」页还可把<strong>呈现方式</strong>切到 PTC（程序化工具调用）＝模型只看到 <code>run_code</code>，用一段程序组合调用该预设启用的工具。' },
            console: { name: '控制台', desc: '实时查看执行计划、任务清单、工具调用时间线与后台任务。' },
            log: { name: '日志', desc: '会话事件日志（JSONL）：事件流、消息派发与完整性。' }
          }
        },
        helpg: {
          title: '❓ 帮助',
          items: {
            help: { name: '软件帮助', desc: '本页：模块化说明与快速上手，并可查看更新日志。' }
          }
        }
      },
      contextUsage: {
        title: '🧮 上下文窗口与占用圆环',
        overview: '每个对话都有自己的<strong>上下文窗口</strong>（模型一次能记住的 token 上限）。主页聊天标题右侧的<strong>圆环</strong>就是当前对话的占用率：悬停显示「已用 / 上限」与判定依据；低于 70% 为主题色，70–90% 变橙，≥90% 变红，提示该新建对话了；达到 <strong>80%</strong> 时会自动压缩较早的对话（见第 4 条）。',
        step1: {
          title: '已用 token 的口径',
          desc: '优先使用后端返回的<strong>真实 promptTokens</strong>；后端不回传用量时，按与实际请求一致的口径<strong>估算</strong>，并在悬停提示里标注「（估算）」。估算会把<strong>工具结果（读取到的文件正文）</strong>、<strong>工具参数（写入的文件正文）</strong>、<strong>知识库召回片段</strong>、<strong>附图</strong>与<strong>固定开销（system prompt + 工具 schema + 会话种子）</strong>一并计入，并按<strong>实测校准系数</strong>修正：本地模型（Ollama / LM Studio）的 tokenizer 与估算口径差异可达 15%~30%，系数按「来源 + 模型」记住后自动套用。集群模式不显示圆环（每个成员各有独立上下文，合并数值没有意义）。'
        },
        step2: {
          title: '分母（窗口上限）从哪里来',
          desc: '优先级为：<strong>来源级手填 &gt; 后端真实探测 &gt; 模型名关键字 &gt; 来源默认值 &gt; 128K</strong>。Ollama / LM Studio 会主动探测已加载实例的真实窗口（例如本地 Ollama 手动设成 64K 也能被读到），不可探测的来源按模型名 / 来源默认值估算。'
        },
        step3: {
          title: '「模型」页里的两行只读信息',
          desc: '设置 → <strong>模型 → 来源</strong>。<strong>Ollama 与 LM Studio</strong> 的配置块有一行 <strong>模型加载状态</strong>：网格逐列列出全部模型及其类型（对话 / 视觉 / 嵌入）、是否已加载、<strong>生效上下文</strong>与<strong>模型上限</strong>的对照（Ollama 还会显示 Modelfile 的 num_ctx），并可 <strong>⬇ 加载 / ⏏ 卸载</strong>（Ollama 走 keep_alive，嵌入模型自动改用 /api/embed；LM Studio 走官方 lms 命令）；不限高度、不出滑块，因此这两个来源不再重复显示「上下文窗口」行。其余来源仍有一行只读的 <strong>上下文窗口</strong>显示圆环实际使用的分母；需要重新探测时，点该块底部的 <strong>API 状态</strong> 即可（各来源的刷新按钮已合并到这一处）。<strong>窗口上限覆盖</strong>行仅在你历史上设置过覆盖值时才会出现（届时可 ✕ 清除）。',
        },
        step4: {
          title: '上下文自动压缩',
          desc: '占用达到窗口上限的 <strong>80%</strong> 时会<strong>自动压缩</strong>：较早的对话被替换为一份结构化摘要（最近 3 轮原文逐字保留），摘要随会话保存、可在「设置 → 日志」查看。模型仍记得任务目标、已完成的结论、涉及的文件与未决问题，更早的原文细节则由摘要代替——<strong>聊天里的原始消息一条都不会删</strong>。若后端直接报「上下文超限」，会自动压缩并<strong>重试一次</strong>；本地 Ollama / LM Studio 头部静默截断（表现为「失忆」）的情况也一并避免。压缩过程<strong>会给出提示</strong>：智能体模式在对话里显示「<strong>正在压缩上下文…</strong>」，完成后这张卡片变为「已压缩较早对话（原消息仍保留）」并弹一条提示；普通聊天在发送前 / 重试压缩时也会提示。'
        },
        note: {
          title: '📌 使用提示：',
          text: '窗口上限是「来源 + 模型」级别的：切换模型后分母会随之变化。若圆环数值明显异常，可在该来源配置块底部点一次 <strong>API 状态</strong> 重新探测，或确认所用后端是否会回传 token 用量（不回传时显示的是估算值）。'
        }
      },
      webSearchSources: {
        title: '🔎 联网搜索源（web_search）',
        overview: '智能体、批量任务与工作流「网络搜索」节点共用同一个 <strong>web_search</strong> 工具。默认使用<strong>免 Key 的 Bing 网页</strong>；在 设置 → 工具 → <strong>搜索</strong> 里可<strong>同时启用多个</strong>搜索源（左侧列表开关），并选多源策略：<strong>依次回退</strong>（按列表顺序逐个尝试，第一个有结果即用）/ <strong>并行聚合</strong>（全部执行后按 URL 去重合并）；还可用左侧 <strong>+</strong> 添加<strong>自定义（内网）源</strong>。改完立即生效、无需重启。',
        step1: {
          title: '免 Key 搜索源（开箱可用）',
          desc: '<strong>Bing 网页</strong>（默认，长中文句会自动改写为关键词）、<strong>百度</strong>、<strong>DuckDuckGo</strong> 无需任何配置；前两者国内网络直连可用，DuckDuckGo 部分网络环境可能被拦截。'
        },
        step2: {
          title: '自建 / API Key 搜索源',
          desc: '<strong>SearXNG</strong> 填自建实例地址（需实例开启 JSON 输出）；<strong>博查</strong>、<strong>智谱</strong>、<strong>Tavily</strong>、<strong>Brave</strong> 填各自 API Key（智谱可选基础 / 高阶搜索）。Key 只保存在本机，不会随聊天内容上传。'
        },
        step3: {
          title: '自定义（内网）搜索源',
          desc: '左侧 <strong>+</strong> 可添加任意数量的自定义源，专给<strong>局域网内网源</strong>用：<strong>SearXNG 兼容实例</strong>（只填实例地址，如 <code>192.168.1.10:8080</code>，需实例开启 JSON 输出）或 <strong>HTTP JSON 接口</strong>（内网 wiki / 搜索服务：填请求地址，GET 可用 <code>{query}</code> 占位、留空则自动追加 <code>?q=</code>；可填 API Key（自动作 Bearer）与自定义请求头（值里可用 <code>{key}</code>），并指定结果数组路径与标题 / 链接 / 摘要字段）。自定义源与内置源一起<strong>拖动排序 / 启用 / 测试</strong>，同样参与回退 / 聚合；右侧「删除」可移除，左上角 ↺ 重置会一并清除。'
        },
        note: {
          title: '📌 使用提示：',
          text: '列表<strong>从上到下就是尝试顺序</strong>（可<strong>直接拖动</strong>搜索源调整位置，回退策略下即优先级）；每个源可单独<strong>测试</strong>（与启用状态无关），「测试全部启用源」会<strong>逐个测试每个已启用源</strong>并展开各自结果与失败原因；左上角 ↺ 可<strong>重置</strong>全部搜索源配置（清空 Key / 恢复 Bing 单源）；<strong>返回条数</strong> 控制每次搜索结果数量（1~20）。页内文档与结果链接均用<strong>自带浏览器</strong>打开（不跳系统默认浏览器）。抓取具体网页（web_fetch）不受搜索源影响。'
        }
      },
      builtinMcp: {
        title: '🧩 内置 MCP 服务（随软件预置）',
        overview: '设置 → 工具 → <strong>MCP</strong> 面板中预置了六个<strong>进程内内置服务</strong>（启动 / 进入设置页时自动注入、默认启用并自动连接、<strong>不可删除</strong>）：它们不依赖外部进程，其工具可被通用智能体 / Agent 预设 / 工作流 MCP 节点调用，也可「对外 HTTP 暴露」供 Claude Desktop、Cursor 等其他 MCP 客户端接入（见左侧「内置服务：对外 HTTP 暴露」开关）。',
        browser: {
          name: '内置浏览器 Agent（builtin-browser）',
          desc: '提供<strong>AI 可控制的真实浏览器窗口</strong>（多标签），暴露 browser_navigate / list_tabs / new_tab / switch_tab / close_tab / get_html / extract_text / extract_markdown / screenshot / click / type / scroll 等 browser_* 工具，让 AI 可以上网查资料、点击填表、抓取并整理页面内容；由主进程浏览器 Agent 服务实现，入口见「知识管理」章节的「浏览器操作」。'
        },
        office: {
          name: 'Office 文档读写（builtin-office，Word + Excel）',
          desc: '读写本地 <strong>.docx</strong> 与 <strong>.xlsx</strong>（共 34 个函数，会话式：open 后返回 docId / workbookId）。<strong>Word</strong>：open_document / list_blocks / read_text / <strong>find_text</strong>（查找定位） / <strong>document_info</strong>（字数·大纲·样式表） / export_markdown（转 Markdown） / find_and_replace_text / <strong>replace_paragraph</strong>（整段重写，保样式） / <strong>insert_paragraph</strong> / <strong>insert_table</strong> / <strong>insert_markdown</strong>（Markdown 成段写入）/ <strong>set_paragraph_style</strong>（标题级别·样式） / <strong>delete_block</strong> / save_document（自动 .bak 备份）；<strong>样式</strong>：<strong>list_styles</strong>（样式清单·格式·引用次数） / <strong>create_style</strong>（新建段落·字符样式） / <strong>update_style</strong>（改样式定义，正文自动跟随）/ <strong>delete_style</strong> / <strong>set_text_format</strong>（给选中文字直接设字体·字号·加粗·颜色，不依赖样式）。<strong>Excel</strong>：open_workbook / list_sheets / read_sheet（区域读取，Markdown/JSON/CSV，可看公式）/ search_cells（定位单元格）/ <strong>query_rows</strong>（多条件筛选·排序·分页，返回紧凑表格）/ <strong>aggregate</strong>（<strong>一步出统计</strong>：<strong>多列分组</strong>、每组<strong>行数与占比</strong>即频次，另有求和·均值·计数·去重·极值；<code>sortBy:"行数" + limit</code> 即可取「频率最高的值」）/ set_cells（批量写单元格，保留原样式）/ append_rows / add_sheet / rename_sheet / delete_sheet / create_workbook（新建）/ save_workbook / close_workbook。写入均<strong>只改动对应 XML 部件</strong>（正文只改 document.xml、样式改动只改 styles.xml，公式 / 图表 / 图片全部保留），保存前自动生成 <code>.bak</code> 可回滚；.xls / .csv 只能读取查询（写回会提示先另存为 .xlsx）；工具参数在调用前会做<strong>别名归一</strong>（如 query_sheet → sheet、workbook_id → workbookId），漏传必填参数（如 workbookId / docId）会被直接拦住并提示先 open，不再笼统报「会话已关闭」；Excel 的读取 / 统计工具还可<strong>直接传 path</strong>（同路径已有会话即复用，没有就自动打开），<strong>统计类结果默认输出紧凑表格并限制单次输出量</strong>（可用 maxChars 调整），小上下文窗口（如 32k）不会再被一两次结果占满。'
        },
        drawio: {
          name: 'drawio 图表（builtin-drawio）',
          desc: '读写本地 <strong>.drawio</strong> 文件（共 44 个函数，主进程直接改 XML，无需打开编辑器）：<strong>文档 / 页面</strong>（create / read_document / list_pages / get_page / set_page / add_page / rename_page / delete_page）、<strong>查看与校验</strong>（list_cells / get_cell / search_cells / outline / stats / validate）、<strong>增删改</strong>（add_node / add_nodes / add_edge / connect / update_cell / move_cell / resize_cell / set_style / set_label / delete_cell / duplicate_cell / set_z_order / apply_fragment / set_parent）、<strong>容器 · 图层 · 标签 · 元数据</strong>（add_container / add_layer / set_tags / set_metadata）、<strong>布局</strong>（auto_layout 自动分层 / grid_layout / align / distribute / fit_page / translate_all）、<strong>互转</strong>（import_mermaid / export_mermaid / import_csv / export_svg）、<strong>检索</strong>（search_shapes / style_help）。可让 AI 直接“画图、改图、排版、导出”。'
        },
        literature: {
          name: '学术文献检索（builtin-literature）',
          desc: '聚合五个<strong>免 Key</strong> 公开文献数据源，共 9 个工具：<strong>search_crossref</strong>（CrossRef 检索：全字段/标题/作者字段、年份、类型、排序；<strong>query 传 DOI 自动转精确查询</strong>；<strong>update_type</strong> 直达撤稿通知并给出被撤原文 DOI 与 Retraction Watch 编号）、<strong>search_openalex</strong>（OpenAlex 检索：被引数、OA 状态与全文入口、摘要；支持 <strong>retracted_only</strong> 只看被撤稿、<strong>author_id</strong> 查某作者全部论文）、<strong>search_arxiv</strong>（arXiv 预印本，支持 ti: / au: / cat: 语法）、<strong>search_pubmed</strong>（PubMed，支持 retracted publication[pt] 等撤稿检索）、<strong>search_europepmc</strong>（Europe PMC：OA 全文链接 + 撤稿关系 Retraction in/of，支持仅 OA / 仅被撤稿）、<strong>search_authors</strong>（OpenAlex 作者检索：机构 / 论文数 / 被引 / h-index / ORCID）、<strong>get_by_doi</strong>（按 DOI 双源合并取完整元数据）、<strong>get_retraction_info</strong>（按 DOI 三源合并查撤稿状态与通知记录）与 <strong>get_fulltext</strong>（按 DOI / PMID / PMCID 获取开放获取全文正文）。让 AI 直接检索文献、核对引用、寻找免费全文、批量核查撤稿——全部走官方 API，不经过网页人机验证。'
        },
        postgres: {
          name: 'PostgreSQL 查询（builtin-postgres）',
          desc: '把本地 / 内网 PostgreSQL 库（典型场景：导入 <strong>OpenAlex 离线快照</strong> 等大数据集）以<strong>只读</strong>方式交给 AI 查询，共 7 个工具：<strong>pg_resolve_author</strong>（<strong>作者消歧</strong>：人名——可只给姓或「姓+首字母」——加可选机构参考，一次调用返回候选表 + 机构历史 + 代表作 + 置信分档，无结果时返回 No Result；机构名在库里不存在或给缩写时会自动退化为关键词匹配）、<strong>pg_status</strong>（连接配置与连通性自检，报错先调它）、<strong>pg_list_schemas</strong>、<strong>pg_list_tables</strong>（表/视图清单 + 行数估算 + 注释，支持关键字）、<strong>pg_describe_table</strong>（列/类型/索引/表大小）、<strong>pg_sample_rows</strong>（采样看数据形态）、<strong>pg_query</strong>（执行只读 SQL：支持聚合、CTE、JOIN、窗口函数，返回 Markdown 表格）。<strong>三层只读保护</strong>：SQL 静态校验（仅 SELECT/WITH/TABLE/VALUES/SHOW/EXPLAIN，拒绝多语句与写类关键字）、连接强制 <code>default_transaction_read_only=on</code>、语句超时（默认 30 秒，可用 <code>PG_MCP_STATEMENT_TIMEOUT_MS</code> 调大），缺省 LIMIT 自动补上；连接后自动把库里唯一的用户 schema（如 openalex）设为 search_path，SQL 可直写表名。连接信息在「配置 → 环境变量 env」填写（<code>PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD</code>，或单条连接串），密码只存本机设置、不会随智能体请求发送给模型服务商；建议再配只读数据库账号（GRANT SELECT）。'
        },
        pluginDev: {
          name: '插件开发参考（builtin-plugin-dev）',
          desc: '把官方<strong>插件开发指南</strong>作为 MCP 服务提供，按主题拆成 <strong>6 个短工具</strong>（每次只回几百到三千字，小模型也吃得下）：<strong>plugin_dev_host</strong>（本机插件目录的<strong>绝对路径</strong> / 已装插件清单 / 数据放哪）、<strong>plugin_dev_constraints</strong>（15 条硬性约束，含「只准调用指南列出的宿主 API、界面 / 主进程两半边不能混用」与「canvas 2D 不认 CSS 变量」）、<strong>plugin_dev_manifest</strong>（<code>package.json</code> 清单字段 + 内置槽位 + 可直接照抄的清单）、<strong>plugin_dev_api</strong>（宿主 API 速查 + 最小可运行示例全文）、<strong>plugin_dev_faq</strong>（报错对照）、<strong>plugin_dev_templates</strong>（模板目录与安装步骤，正文用 <code>key</code> 逐取，如 <code>{"key":"panel"}</code>），另有 <strong>plugin_dev_check</strong>（自检：目录名能否作为插件 id、清单 / 入口文件、<strong>是否用了宿主不存在的 ctx 成员</strong>（如 ctx.service / ctx.files.readFile 会逐条报出并给出正解，两半边 ctx 串用也会报）、<strong>漏 await / 返回形状用错 / 观察器没断开 / 把 <code>ctx.locale</code> 的 ref 当字符串用（提示显示 <code>[object Object]</code>）</strong>这类「不报错但没数据」的陷阱，用宿主<strong>同一份</strong>校验逻辑，并返回<strong>宿主真实的加载状态与日志</strong>，含界面半边装载失败的原因）——内容与「设置 → 插件 → 开发」页同源。<strong>插件开发智能体</strong>默认已绑定本服务（经 mcp_call 调用）；其它智能体、工作流 MCP 节点、以及外部 MCP 客户端（<code>/mcp/builtin-plugin-dev</code>）都能用它，从而不必去磁盘上找软件源码。'
        },
        note: {
          title: '📌 使用提示：',
          text: '内置服务对「删除」按钮不可用（防止误删后浏览器 / Word 能力丢失），但仍可<strong>关闭启用开关、编辑名称、测试连接、查看函数</strong>；若从列表中被移除，重启或再次进入该设置页会自动重新注入。'
        }
      },
      closeBehavior: {
        title: '🚪 关闭按钮行为与托管区（系统托盘）',
        overview: '设置 → 通用 → <strong>基础</strong> → 「<strong>关闭按钮行为</strong>」决定点右上角关闭按钮时发生什么：<strong>直接退出软件</strong>（默认）或 <strong>折叠到托管区</strong>（收起窗口、后台继续跑）。',
        quit: {
          title: '直接退出软件（默认）',
          desc: '点关闭即退出程序。若后台仍有任务在运行（批量智能体 / 采集 / 智能体会话 / 工作流 / 集群），会先弹提醒并阻止一次关闭，<strong>6 秒内再次点击</strong>才真正退出，避免误触中断任务。'
        },
        tray: {
          title: '折叠到托管区（后台继续运行）',
          desc: '点关闭只把窗口<strong>收起</strong>到屏幕右下角「托管区」（Windows 通知区域 / macOS 菜单栏），程序与后台任务<strong>不受影响</strong>地继续运行；因为不会中断任务，折叠时<strong>不再弹提醒</strong>，首次折叠会有一个气泡提示。<strong>文件窗口</strong>（画布 / 脚手架等独立窗口）在<strong>后台任务运行中</strong>关窗时同样只收起、不结束任务（可从托管区唤回），没有任务在跑时关窗即正常关闭。'
        },
        trayMenu: {
          title: '📌 托管区图标可以做什么：',
          hover: '<strong>鼠标悬停</strong>：显示后台任务数与<strong>每个任务</strong>的进度与预计剩余时间（如「AI-KM · 3 个任务运行中 / · Agent脚手架 12/50 剩 3分20秒 / · Agent脚手架 3/80 剩 9分10秒」）—— Agent脚手架任务会给出<strong>已完成/总数</strong>与<strong>预计剩余时间</strong>（本段还没跑完任何一项时显示「剩 估算中」）；受系统提示长度限制只列前后几个任务，并在末尾标「…还有 N 个」，完整列表看右键菜单。',
          leftClick: '<strong>单击图标</strong>：窗口在前台时收起、已收起时唤回；<strong>双击</strong>始终唤回窗口。',
          rightClick: '<strong>右键菜单</strong>（系统原生菜单）：显示主窗口 / <strong>设置…</strong>（直达「基础」，方便改回关闭行为）/ 后台任务列表（多个窗口同时有任务时按窗口分组，<strong>点某条任务即唤回它所在的窗口</strong>）/ 隐藏的窗口（列出已收起的窗口，点一下即唤回）/ 退出 AI-KM。'
        },
        note: {
          title: '📌 使用提示：',
          text: '想彻底退出请用右键菜单的「退出 AI-KM」（或先改回「直接退出软件」再点关闭）；「设置…」会打开设置独立窗口并定位到「基础」。'
        }
      }
    },
    dataCanvas: {
      usage: {
        title: '📂 使用方式（.data 画布文件）',
        items: [
          '文件类型：<code>.data</code> 就是画布文件——在<strong>知识管理</strong>的文件树里打开它：<strong>浏览</strong>与<strong>可视编辑</strong>视图都渲染数据画布模块（模块自带 主页 / 数据 / 画布 / 帮助 四个子标签），<strong>源码编辑</strong>视图显示 JSON 文本',
          '新建：文件树顶部 ➕ 创建文件，或文件树 / 文件视图右键「新建 → 数据画布」，类型选 <strong>数据画布</strong>（<code>.data</code>）；新建的文件打开即<strong>空画布</strong>，可直接建模',
          '保存：画布内容变更后约 <strong>1.5 秒防抖自动保存</strong>回它自己的 <code>.data</code> 文件，工具栏 💾 也可手动保存；保存后已打开的标签内容同步（切到源码编辑立刻能看到新 JSON），其它窗口 / 标签也会被通知刷新',
          '切换文件：切换标签时未保存的改动会<strong>先静默写回原文件</strong>再载入新文件，新文件为空时画布清空（不残留上一个文件的内容）；关闭标签 / 离开知识管理时同样先写回',
          '独立窗口：文件右键「打开」<strong>固定为画布</strong>（没有视图切换器）；要改 JSON 请在知识管理里切到「源码编辑」。<code>.data</code> 已注册系统文件关联，双击即用本应用打开',
          '两种用法：既可作为画布文件打开编辑，也可用画布工具栏「导出」得到 <code>.data</code> 数据包、或把 <code>.data</code> 拖进画布作为<strong>子画布节点</strong>导入（两者内容同构：<code>models</code> + <code>activeModelId</code>）'
        ]
      },
      overview: {
        title: '什么是数据画布？',
        description: '数据画布是<strong>知识管理中的一种文件类型</strong>（<code>.data</code>，不再是顶层模块、也没有单独的导航入口）：在画布上用节点与连线做<strong>无代码数据建模</strong>——表格 / 参数 / 图表 / 子画布等节点，可缩放、吸附网格、一键重新计算；「数据」页为每列配置<strong>表单录入</strong>方式（文本 / 多行 / 数字 / 日期 / 下拉 / 开关）并批量录入，「主页」页以图表看板展示。画布内容会<strong>自动保存</strong>到它自己的 <code>.data</code> 文件（变更后约 1.5 秒防抖，工具栏 💾 可立即保存），在知识管理中双击 <code>.data</code> 即打开本模块并加载。'
      },
      scenarios: {
        title: '典型场景',
        items: [
          '多单位统计与辅助决策：各单位按统一模板填报（或导入 Excel），用数据表建模汇总、图表节点展示对比，据此完成<strong>成本测算、预算分配与方案取舍</strong>',
          '项目 / 成本管理：为项目建立台账表（预算、实际、偏差）、关键指标参数与趋势图，一处录入、看板全局同步',
          '科研实验数据：参数节点记录实验条件、数据表记录样本与测量值、图表节点对比多组结果，数据包可导出备份或分享',
          '轻量业务台账：用多张表 + 子画布搭建「数据字典 / 台账 / 报表」体系，替代分散的 Excel 文件'
        ]
      },
      steps: {
        title: '使用步骤',
        items: [
          '在<strong>知识管理</strong>的文件树里打开 <code>.data</code> 文件（<strong>浏览</strong> / <strong>可视编辑</strong>视图即画布模块）',
          '「画布」页双击空白处或点 + 添加节点（表格 / 参数 / 图表 / 子画布等），拖拽摆位、连线定义数据流向；选中节点后可在右侧属性面板编辑',
          '「数据」页录入数据：按列配置录入方式（或由表格节点从 Excel / Markdown 导入），侧边栏按标题字段快速切换记录',
          '「主页」页查看图表看板：支持顺序排列 / 自定义拖放与布局锁定；画布工具栏可导出 / 导入 <code>.data</code> 数据包'
        ]
      },
      notes: {
        title: '说明',
        items: [
          '画布文件为 <code>.data</code>：内容变更自动保存，文件缺失时下次保存会重新询问位置',
          '一个画布文件可容纳多个数据模型，随文件一起保存与恢复；导出数据包用于分享或备份',
          '画布不再从 <code>.task</code> 打开：旧的画布 <code>.task</code> 文件（内容形如 <code>{ "models": [...] }</code>）双击时会提示改用 <code>.data</code> 扩展名——把它<strong>改名为 <code>.data</code> 并放进工作区</strong>，即可在知识管理里继续当画布编辑（内容形状同构，改名即可打开）',
          '画布顶栏会随面板宽度<strong>自动换行</strong>：分屏或窗口很窄时右侧按钮不会被裁掉'
        ]
      }
    },
    agentScaffold: {
      overview: {
        title: '什么是 Agent脚手架？',
        description: 'Agent脚手架是<strong>通用 Agent 执行框架</strong>（应用内称 Harness）：以<strong>表格驱动</strong>的方式跑批量任务——<strong>唯一的脚手架就是它自己</strong>：原批量智能体运行 / 表格定向推理 / 文件采集表格 / 链接采集表格四种脚手架已并入为它的<strong>四种预设</strong>（旧 <code>.task</code> 文件打开时自动转换）。每个 <code>.task</code> 文件就是一个独立任务（专属「脚手架」视图，在独立窗口打开），可中断续跑、后台继续；需要“写程序调用工具”的 PTC 能力时，把任务的预设换成<strong>PTC 智能体</strong>即可（聊天 / 工作流 / 集群同样适用）。'
      },
      scaffolds: {
        title: 'Agent脚手架的配置方法（来源 × 执行方式 × 输出方式）',
        batch: {
          title: '⚡ 批量智能体运行（预设）',
          desc: '表格源 × 智能体 × 单独结果（结果列）：导入表格后每行交给一个独立智能体（完整会话、含工具）并发执行，可实时监控与失败重试，支持筛选与批量重跑——批量写作、批量分析、批量生成的经典形态。'
        },
        file: {
          title: '📁 文件采集表格（预设）',
          desc: '文件夹源 × 结构化提取：扫描本地文件（可选扩展名 / 排除目录）逐文件提取输出字段，按主键合并成数据表——从大量文档中整理清单。'
        },
        collector: {
          title: '🌐 链接采集表格（预设）',
          desc: '文本源（每行一个网址）× 抓取网页 × 结构化提取：逐页抓取并把标题 / 发现的链接存为行字段，按「链接跟随」在深度 / 页数约束内自动扩展新任务行——采集网站上的结构化信息，「图谱」页可看爬取轨迹。'
        },
        tabreason: {
          title: '🎯 表格定向推理（预设）',
          desc: '表格源 × 纯 LLM 推理 × 结构化提取：在「任务指令」引用行数据、在「输出字段」为每列配置推理指令（可留空 → 按字段名自动分析），逐行推理产出记录——给已有表格批量打标签、补全字段、风险评级；结果进数据表、导出为新表。'
        },
        presets: {
          title: '四种预设（一键套用）',
          note: '任务页「预设」下拉可一键套用（自动联动 来源 / 执行方式 / 输出方式与参数，已导入的任务行保留；手动改动任一维度后回到「自定义配置」）。'
        },
        pipeline: {
          title: '🧩 Agent脚手架',
          desc: '以「批量智能体运行」为骨架演进的<strong>Agent脚手架</strong>：任务页拆为<strong>来源</strong>、<strong>执行方式</strong>与<strong>输出方式</strong>三个维度——来源可选 <strong>表格（导入 xlsx / csv）</strong>、<strong>文件夹（扫描本地文件，逐文件生成任务行）</strong> 或 <strong>文本（每行一条：可粘贴网址 / 文件路径 / 任意文本）</strong>；执行方式可选 <strong>智能体（完整会话，带工具）</strong>（任务指令、并发智能体）或 <strong>纯 LLM 推理（无工具）</strong>；输出方式可选 <strong>单独结果</strong>（智能体→结果列；纯 LLM→逐列写回原表新列）或 <strong>结构化提取</strong>（每行输出 JSON，按字段/主键合并进数据表；智能体与纯 LLM 都可用）——单独结果即「只有一个字段的结构化结果」，两者共用导出列 / 运行信息配置，相互切换不会丢失导出列选择；旧「表格定向推理」任务读取后自动落在「结构化提取」（旧写回值会转成数据表记录）。纯 LLM 的结构化分支另含<strong>任务目标</strong>（支持 {{列名}} 占位符）与<strong>内容获取</strong>（行数据 / 读取字段中的本地文件 / 抓取字段中的网页——抓网页即链接采集，会把页面标题与发现的链接存为行字段并按「链接跟随」策略在深度与页数约束内自动扩展新任务行）。<strong>任务页</strong>无外框无标题，三列排布：左列＝<strong>执行与配置</strong>一张卡片（<strong>操作栏并入卡片顶部</strong>：读取 / 保存 / 另存为 · 重置 / 停止 / 启动；随后就是<strong>预设</strong>下拉），中列＝<strong>输入</strong>，右列＝<strong>输出</strong>（窄窗口直接降为单列——不再有中间的两栏态；三列面板铺满任务页高度，内容超高时在各自面板内滚动——左列配置项随卡片整体上下滚动；输入面板里「数据选择」在上、「任务指令」占满剩余高度）：「预设」下拉（批量智能体运行 / 表格定向推理 / 文件采集表格 / 链接采集表格）可一键套用旧脚手架的配置形态，手动改动后回到「自定义配置」；「读取」还能直接打开旧脚手架的 .task 任务文件并自动转换（含写回值 / 任务行 / 已采集数据）。导入表格或选择文件夹后，输入面板下方会显示<strong>来源路径</strong>（附行数，悬停看全文）；「执行」面板的<strong>详情标题</strong>可选详情表格左列显示哪个字段（不显示 / 一个字段，运行中可随时切换）；「输出」面板的<strong>输出字段</strong>以表格编辑（字段名 + 推理指令 / 说明；结构化提取时另含「必填 / 主键」两列）——逐列写回与结构化提取<strong>共用同一张字段列表</strong>，切换输出方式不用重配；<strong>输入</strong>面板分<strong>任务指令</strong>（原「任务模板 / 任务目标」统一，含 {{列名}} 占位符，每行渲染一次，三种执行方式共用）与<strong>数据选择</strong>（点列名把 {{列名}} 写入 / 移除任务指令，已引用高亮，带全部引用 / 全部移除；结构化提取的「内容获取 / 取值字段 / 抓取设置」也在此）两段。页面按标签页分工：<strong>任务</strong>（配置与启动）、<strong>详情</strong>（每行一个子任务：状态 / 开始结束时间 / 耗时 / 推理步数 / Token（<strong>纯 LLM 推理同样统计行 Token</strong>）/ 错误；<strong>结构化提取按「提取字段」、逐列写回按「目标列」逐列展示</strong>，点行看完整记录（写回模式可在行详情里改目标列结果 JSON）与提取数据；运行中可直接<strong>停止</strong>）、<strong>结果</strong>（预览与导出：结构化模式看提取数据集，否则只读一览全部行；纯 LLM 写回列自动成列；导出预览：结果页直接展示<strong>导出 Excel 会写入的内容</strong>，列在「输出」面板配置（竖向列表逐项开关原表列 / 运行信息（行号 / 任务指令 / 状态 / 时间 / Token…）/ 各轮结果，拖动手柄调整顺序——顺序即导出表的列顺序，点列名即可改名（结果页表头与导出的 Excel 同用此名，改过名的列标出原名），结构化模式下按产生该条数据的任务行合并；「输出方式 / 输出字段 / 导出列」的说明文字改为在标题上悬停查看）、结果页<strong>渐进式加载</strong>（滚动到底自动继续），支持全列关键字搜索、按列筛选与行号跳转高亮，并可<strong>逐条删除</strong>单条结果；重跑结构化提取默认 <strong>替换该行原有结果</strong>（可在「输出 → 重跑结果」改为「保留并合并」）；结果表最左「<strong>任务行</strong>」列点号可直接跳到「详情」对应行；源表改过时点「<strong>同步源表</strong>」重读并按行指纹 / 首列值把结果对回原位（新增 / 已变更 / 已移除都标出来，工具栏「+新增 ~变更 -移除」里点「新增 / 变更」即在下方表格筛选、悬停看列级差异与对位说明）；源表增删 / 改过行后重读表格会按<strong>行指纹</strong>把历史结果对回正确的行，并给出「新增 / 已变更 / 已移除」增量（已变更 = 还是同一行、结果仍留在该行上（源数据改过，建议重跑）；已删行的多余结果会自动删掉（对位不可靠时只标「已移除」，结果页「已移除 N」按钮可只看这些）；结果条数多于任务行数时表下会给出统计，工具栏的「异常 N」按钮可筛出不属于任何任务行的结果（「删除这些」可删掉，「清除」只取消筛选），「同步结果」则按当前任务行重建结果、数量与数据都与任务行一致））；增删位置不可靠时只报行数增减）、<strong>图谱</strong>（链接采集的<strong>爬取轨迹</strong>——节点=页面、边=谁发现谁、给出深度分布；或任意智能体行的<strong>访问路径</strong>——每行一个「智能体」节点（紫），连向它访问过的信源与调用过的 MCP 服务（未调用工具的智能体也显示为单个节点）；工具栏用<strong>彩色圆点图例</strong>展示各类型（单击即筛选显示 / 隐藏），节点上限与视图选择同栏（默认 2000；打开时先给一个较广的初始视角，布局收敛后自动把全部节点框进视口并居中——自己缩放 / 拖动后就不再自动调整了）；不需要时可在「执行与配置」取消勾选 <strong>启用「图谱」标签页</strong>（关闭后不做投影、也不显示该页签）；默认视图会按任务自动选择（有网页行 → 爬取轨迹，否则有过程快照 → 访问路径），无内容时给出说明文案）与<strong>日志</strong>（左侧导航栏纵向列出主日志与各线程、级别筛选；清空按钮在导航栏标题右侧）。旧的批量 / 表格推理 / 文件采集 / 链接采集 <code>.task</code> 文件打开时会自动转换为本流水线配置。'
        }
      },
      usage: {
        title: '使用步骤',
        items: [
          '在<strong>知识管理</strong>的文件树 / 文件视图里双击（或搜索、右键打开）一个 <code>.task</code> 文件，即在<strong>独立窗口</strong>里打开它的专属「脚手架」视图；也可用右键「新建 → 脚手架」新建一个（写入空任务骨架，随即打开窗口）',
          '一个窗口只服务一个 .task（单文件隔离；再次打开同一文件会聚焦已开的窗口）：脚手架本体就在窗口里——任务 / 详情 / 结果 / 图谱 / 日志 页签，底部状态栏的 读取 / 保存 / 另存为 · 重置 / 停止 / 启动，配置与结果都写回这个文件',
          '「新建 → 脚手架」写入的是空任务骨架（<code>scaffold: pipeline</code>）；在任务页左上「<strong>预设</strong>」下拉选四种形态之一（批量智能体运行 / 表格定向推理 / 文件采集表格 / 链接采集表格），或保持「自定义配置」',
          '任务页左列「执行与配置」的 <strong>随任务文件保留</strong> 可分别勾选是否把 <strong>图谱数据</strong>（行过程快照，图谱与行详情的数据来源）与 <strong>运行日志</strong> 写进任务文件（重开后仍可查看）；<strong>默认两者都不保留</strong>（任务文件更小）',
          '任务页「<strong>轮次</strong>」可对同一批任务行跑多轮：新建轮次保留行数据（状态置回待处理）、可换配置或指令再跑，每轮各存一份配置快照与结果，用下拉切换查看（结果 / 图谱 / 导出都针对当前轮）',
          '「数据选择」里的<strong>前轮结果</strong>芯片（如 <code>{{第1轮.结果}}</code> / <code>{{第1轮.字段}}</code>）可把前几轮产出写进本轮指令（取<strong>同一行</strong>的前轮结果）；「导出列」里再勾选想要的轮次，就能把各轮结果按行<strong>并排成列</strong>对比',
          '轮次区带 <strong>⑂</strong> 的按钮是<strong>链式新轮次</strong>：把本轮结果展开成新一轮的任务行（结构化提取逐条记录成一行），适合先发散再收敛；多轮时可打开「<strong>对比</strong>」页签，把同一批行在各轮的产出并排看（⚠ 不一致、? 缺结果；上方「轮次」芯片可点选显示 / 隐藏该轮，至少保留一轮）；点任意一格的产出即可弹窗用 Markdown 渲染预览（标题显示所属轮次），表格始终列出全部行（只在其它轮出现的行也会列出，该轮无结果显示 —）',
          '点表格行弹出<strong>行详情</strong>，分<strong>任务 / 过程 / 输出</strong>三个页签（页签在左、运行计数（开始 / 结束 / 耗时 / 步数 / Token）在右；切换页签后会保持，连续核对多行不用反复切）：任务 = 占位符替换后真正发出的任务，过程 = 推理步骤与工具调用（与主页对话的工具盒子同款：<strong>默认只显示单行摘要</strong>，点一下展开参数与结果，运行中实时更新），输出 = 提取数据 / 写回列 / 结果文本（运行中<strong>直接流式显示渲染后的正文</strong>，不再显示 Markdown 源码；Markdown 按预览尺寸紧凑排版，不再整段被撑高）；<strong>底部按钮栏</strong>从左到右是页签对应的操作（复制 / 编辑，编辑时变保存 + 取消）→ <strong>状态下拉</strong>（待处理 / 已完成 / 失败 / 跳过，只改状态、结果不动——选「待处理」即待执行，回任务页点启动就会跑它；执行中的行不可改）→ <strong>停止本行</strong>（仅该行执行中显示：取消它的会话或请求，收尾为「跳过」，<strong>其它行与整批不受影响</strong>）→ <strong>重跑本行</strong>（不是执行中时显示：批量运行中→插到队首立即执行，未运行→置待处理并启动）→ 删除，右侧是关闭（按钮与下拉同高；详情表格的「操作」列只显示状态文字，不再放任何按钮）',
          '「<strong>详情</strong>」页的<strong>筛选</strong>按钮打开筛选面板：状态 / 搜索 / 结果 / 行号 / 步数 / 耗时 集中在一处（步数、耗时用 <strong>&lt; ≤ &gt; ≥ =</strong> + 数值；未运行按 0 步 / 0 秒，耗时默认秒且可写 90 / 1.5m / 2m30s），面板内实时显示<strong>命中行数</strong>；命中行可一键<strong>批量标记</strong>为 待处理（= 待执行，下次启动即跑）/ 跳过 / 已完成 / 失败，或直接「重跑命中行」（标记待处理并立即执行）',
          '按 <strong>来源 / 执行方式 / 输出方式</strong> 三个维度补齐配置：来源 = 表格 / 文件夹 / 文本，执行方式 = 智能体 / 纯 LLM，输出方式 = 单独结果 / 结构化提取；再点「启动」开始',
          '任务支持中断续跑（状态保留），并保存在自己的 <code>.task</code> 任务文件中，重开该文件即可继续',
        ]
      }
    },
    agentSwarm: {
      overview: {
        title: '什么是集群（多智能体协作）？',
        description: '集群是<strong>主页的一种对话模式</strong>：在主页输入区把模式切到「集群」，就能让<strong>多个智能体参与同一条对话</strong>——发送任务后成员依次发言，你可以 <code>@成员名</code> 只点名某一位，也可以同时勾选多位让他们各自作答、最后由群主汇总。<strong>成员就是 Agent 预设</strong>（在「设置 → 智能体 → 预设」中维护）：改预设即改成员，对话里只记录“选了哪几个预设”，不再有独立的集群预案文件。成员的回复、工具调用与推理过程与其它模式<strong>完全一样</strong>地显示在同一条对话里，并随对话一起保存。'
      },
      steps: {
        title: '使用步骤',
        step1: { title: '准备 Agent 预设', desc: '先到「设置 → 智能体 → 预设」准备成员：每个预设包含角色系统提示、模型、温度与能力（工具 / 技能 / 知识库 / MCP）。集群成员即预设本身，不需要在集群里重复配置。' },
        step2: { title: '在主页切到集群模式', desc: '主页输入区左下角的<strong>模式下拉</strong>选择「集群」，旁边会出现<strong>成员标签</strong>；点击后勾选参与本次任务的预设（<strong>勾选顺序 = 发言顺序</strong>），浮层底部可直接进入「管理预设...」。' },
        step3: { title: '选择运行方式', desc: '成员标签右侧的<strong>运行方式</strong>下拉提供三档：全员响应 / 辩论 / 项目组；该选项随对话保存。' },
        step4: { title: '发送任务 & @点名', desc: '在输入框输入任务并发送：不带 <code>@</code> 时按运行方式让成员参与；输入 <code>@成员名</code> 则<strong>只唤起该成员</strong>单独执行（不总结）。' },
        step5: { title: '查看过程与结果', desc: '成员汇报就是对话里的消息：正文按 Markdown 渲染，<strong>工具调用 / 思考过程以卡片形式内联</strong>（与智能体模式完全一致），可展开查看参数与结果；运行中可 ■ 停止，任务完成后会自动生成对话标题。' }
      },
      modes: {
        title: '运行方式（输入区下拉）',
        'auto-mention': { name: '全员响应', desc: '所有选中成员依次就任务作答；成员也可在回复里 @同事 追加协作。默认方式。' },
        debate: { name: '辩论', desc: '多个成员围绕任务多轮辩论，最后由群主中立总结，适合需要多方对比的决策类问题。' },
        team: { name: '项目组（Lead 编排）', desc: '由第一位成员担任 Lead，自动把目标拆成任务、按依赖指派成员，结束时汇总交付；此模式顶部只有一行（左侧聊天名称、右侧工作台标签），消息、泳道、名册、任务、通信为并列标签且各自全宽；泳道按依赖层级竖向展示任务关系与成员状态；名册显示各成员 token / 工具次数 / 最后活动（超 90 秒无活动会提示可能卡住）；停止后可从任务页「继续未完成任务」；任务页可调并发闸门（1~8），点任务跳转到对应消息、点消息上的任务标签回到任务板；长产出用产出物落成文件（群聊显示可打开的卡片，任务卡带 📎 附件），不占上下文；回合结束后任务板 / 泳道 / 通信 / 产出物都保留（刷新或重启后仍在），顶部回合切换器可回看历史回合（只读）。' }
      }
    },
    browser: {
      overview: {
        title: '什么是浏览器？',
        description: '浏览器是一个<strong>独立窗口的内置网页浏览器</strong>（与知识管理分离）：支持多标签、收藏书签与离线保存整页；更关键的是它能<strong>被 AI 直接操作</strong>——智能体可以在其中打开网页、抓取正文、填写表单与点击，把网页变成可被 AI 使用的信息源。'
      },
      features: {
        title: '能力一览',
        tabs: { name: '多标签浏览', desc: '标签可拖拽排序、悬浮关闭；地址栏支持输入网址或搜索关键词，自动补全与加载状态均有提示。' },
        aiTab: { name: 'AI 会话标签', desc: '智能体打开网页时使用带机器人标记的「AI 会话标签」，与你的手动标签区分；空闲后自动回收，点一下即接管保留。' },
        bookmarks: { name: '收藏书签', desc: '收藏常用页面，书签落盘到「浏览器设置 → 保存文件夹」目录，书签面板可快速打开、编辑与删除。' },
        save: { name: '离线保存整页', desc: '把当前页（含图片、样式等资源）整体保存为离线 HTML，便于归档与后续阅读。' },
        panel: { name: '右侧设置停靠栏', desc: '查看当前标签的 AI 状态（浏览 / AI / 操作中），并执行：在系统浏览器打开、保存整页、回收 AI 会话标签、控制台、允许执行 JS、缓存清理。' }
      },
      steps: {
        title: '使用步骤',
        items: [
          { title: '打开浏览器', desc: '从浏览器入口打开<strong>独立窗口</strong>；或在对话中提出需要访问网页的请求时由 AI 自动调起。' },
          { title: '浏览与检索', desc: '在地址栏输入网址或关键词回车；顶部 ➕ 新建标签，标签可拖拽排序、点击 ✕ 关闭。' },
          { title: '让 AI 操作网页', desc: '在对话里让智能体打开 / 读取某个网页（例如“打开这个页面并摘取要点”），智能体会在 AI 会话标签中操作并把结果带回对话。' },
          { title: '收藏与保存', desc: '用 ⭐ 收藏当前页；需要归档时点右侧设置栏的「保存整页（离线 HTML）」。' }
        ]
      },
      tips: {
        title: '使用要点',
        items: [
          '「浏览器设置」中有<strong>默认页面</strong>（手动打开时首个标签加载，AI 调用不受影响）与<strong>保存文件夹</strong>（书签与离线页的落盘目录，留空 = 当前工作区根目录）。',
          '出于安全考虑，<strong>允许 AI 执行 JS</strong>（browser_eval）默认关闭，可在右侧设置栏按需开启。',
          'AI 会话标签会<strong>空闲自动回收</strong>以免堆积；想保留某个页面就点一下该标签。',
          '缓存管理位于右侧设置栏底部，可查看缓存大小并一键清理。',
          '浏览器 Agent 同时是<strong>内置 MCP 服务（builtin-browser）</strong>：智能体通过 browser_* 工具导航、新建 / 切换 / 关闭标签、读取正文（文本 / Markdown / HTML）、点击、输入、滚动与截图，可在「设置 → 工具 → MCP」中开关与查看函数。截图返回的是<strong>压缩后的 JPEG</strong>（最长边 1024），避免一张大图把模型上下文挤爆。同页还有 <strong>drawio 内置服务（builtin-drawio）</strong>：智能体用 44 个 drawio_* 工具直接创建、查看、修改、布局与导出本地 .drawio 图表。',
          '知识管理中的 <strong>.html / .htm</strong> 本地网页默认交给<strong>内置浏览器</strong>打开渲染（双击 / 搜索 / 各视图点开，与「打开文件」一致），AI 还能继续对其操作、提取正文；要看文件视图预览或改源码，走右键「打开 → 选对应视图」。'
        ]
      }
    },
    faq: [],
    learning: {
      overview: {
        title: '掌握式学习：记忆与复习',
        desc: '<strong>学习</strong>模块把已保存的知识库（<code>.kb</code>）变成可以“学会”的内容：围绕文件与本体实体做掌握度追踪与间隔复习，配合闪卡练习、错题本与考试，形成“练习 → 复习 → 考试”的闭环。学习记录（含作答与已生成的 AI 解析）独立保存在每个知识库旁的 <code>&lt;库名&gt;.learning</code> 中，绝不写入 <code>.kb</code>；知识库更新后旧记录会被标记“过期”保留。'
      },
      viewsTitle: '六大视图',
      view: {
        overview: { name: '总览', desc: '行动中心：下一步建议；整体掌握 / 正确率 / 累计练习在底部状态栏显示；连续学习打卡与近 7/30 天趋势' },
        map: { name: '学习地图', desc: '三种轴：按文件 / 按实体（卡片底部横向进度条，可标记已掌握(跳测)、切换知识类型、清除过期 / 重学）/ 本体图谱（实体关系图，节点颜色即掌握状态；范围下拉可选 全部实体 / 仅已练习 / 全部实体+问题 / 仅已练习+问题 / 切片+问题 / 文件+问题，问题连到它依据的实体或切片 / 来源文件，点节点看详情或开始练习；图例栏可设节点间距（紧凑 / 标准 / 宽松 / 很宽，默认宽松）、显示数量（200 / 500 / 1000 / 2000 / 5000 / 10000 / 20000，默认 2000）与节点标题（跟随数量 / 总是显示 / 不显示，节点越多字号自动越小），超出时图例会标明「已画 / 共多少」）' },
        review: { name: '复习', desc: '到期队列（近期答错 / 连续答错优先），一键开始到期复习；练习卡底部三个标签：答案 / 解析 / 参考切片（出处切片按 Markdown 渲染），右上「答案区」可整块隐藏用于自测' },
        mistakes: { name: '错题本', desc: '左列表 + 右详情：参考答案(来源切片)、错因标注(记忆 / 概念 / 步骤 / 粗心)、AI 讲解与图解讲解、重练此题' },
        solver: { name: '答疑', desc: '就当前知识库直接提问，走与主页相同的智能体循环（自动调用 kb_search 多轮检索，必要时用 search_files 按文本查找或 read_file 读原文）；流式输出并展示执行步骤（每步调用的工具与命中数），答案只依据切片生成、逐条标注引用编号 [n]，引用切片可展开核对。' },
        exam: { name: '考试', desc: '随机 / 勾选切片 / 手动 / 真题仿写四种出题方式(单选 / 多选 / 判断 / 问答)；客观题本地判分、问答题 AI 评分；可把每题计入对应文件学习对象' }
      },
      mech: { title: '核心机制' },
      step1: {
        title: '先有知识库，再选库学习',
        desc: '在「知识处理」切片 / 向量化并保存生成 <code>.kb</code> 后，进入「学习」模块，在左下角状态栏选择该知识库即可开始。下拉会扫描 <strong>全部工作区及其子目录</strong>（工作区在 设置 → 通用 → 基础 → 路径设置 里管理），所以 <code>.kb</code> 不在当前工作区也能选到；同名库会补标所在目录。'
      },
      step2: {
        title: '掌握度与门控',
        desc: '每个文件按作答正确率计算掌握度（0–100%），达到 <strong>90%</strong> 门控即“已掌握”，答错会回退；未达标的对象保持“学习中”，可在地图随时练习。'
      },
      step3: {
        title: '分型间隔复习',
        desc: '对象按知识类型使用不同复习间隔：记忆 1/3/7/14/30/60 天，步骤、概念 3/7/14/30(60) 天，设计 14/28/60 天。答对拉长间隔（连续对 2 次跳两档），答错缩短并重置；到期对象进入「复习」队列（近期答错优先）。<strong>练习不受到期限制</strong>，任何时候都能手动刷。'
      },
      step4: {
        title: '声明掌握 / 过期 / 重学',
        desc: '地图卡片可“声明已掌握（跳测）”跳过已经会的内容，也可“清空重学”撤销；知识库更新后旧记录自动标记“过期”，可一键清除标记或重置。'
      },
      step5: {
        title: '错因标注与考试联动',
        desc: '错题可标注错因（记忆混淆 / 概念不清 / 步骤错误 / 粗心）便于复盘与筛选；考试交卷时可把每题计入对应文件的学习对象，让考试结果同步驱动掌握度与复习。'
      },
      step6: {
        title: '解析与真题仿写',
        desc: '练习卡底部有三个标签：<strong>答案</strong>（参考答案）、<strong>解析</strong>（流式逐字输出并实时渲染 Markdown：一句话核心 / 前置概念 / 分步推理 / 易混点 + 一张知识结构图，首次切到该标签时才生成）、<strong>参考切片</strong>（出处切片按 Markdown 渲染）；错题详情里也有同样的 AI 讲解。解析结果会随学习记录存入 <code>&lt;库名&gt;.learning</code>，再次打开直接显示、可用页脚「重新生成」刷新。学习模块里的 Markdown 排版与主页一致。解析与图内标签<strong>优先用中文</strong>，只有知识库正文本身是英文（或界面切到英文）时才用英文。考试的<strong>真题仿写</strong>可导入或粘贴一份真题，先分析其题型配比与措辞风格（风格档案按知识库保存在本机），再按这个风格仿写新题。'
      }
    },
    footer: {
      tip: {
        label: '💡 使用建议：',
        text: '从最简单功能开始，逐步组合使用。有问题随时查阅帮助！'
      },
      links: {
        feedback: '反馈问题',
        source: '查看源码',
        mineru: 'MinerU转换器'
      }
    }
  },
  en: {
    nav: {
      title: 'AI-KM Help'
    },
    header: {
      title: 'AI-KM Intelligent Productivity Platform',
      subtitle: 'Beginner Friendly Guide · 11 sections'
    },
    sections: {
      'quick-start': {
        title: 'Start',
        subtitle: '5 min + FAQ'
      },
      'concepts': {
        title: 'Concepts',
        subtitle: 'Key terms first'
      },
      'ai-chat': {
        title: 'Reasoning',
        subtitle: 'Home AI chat · five modes'
      },
      'knowledge': {
        title: 'Knowledge',
        subtitle: 'Files & collaboration'
      },
      'know-rag': {
        title: 'Processing',
        subtitle: 'RAG knowledge base'
      },
      'learning': {
        title: 'Learning',
        subtitle: 'Mastery & review'
      },
      'general-files': {
        title: 'General files',
        subtitle: 'Markdown · docs · diagrams · whiteboard'
      },
      'special-files': {
        title: 'Special files',
        subtitle: 'KB · workflow · agent · data canvas'
      },
      'browser': {
        title: 'Browser',
        subtitle: 'Built-in browsing with AI web actions'
      },
      'plugins': {
        title: 'Plugins',
        subtitle: 'Extend tools & UI'
      },
      'settings': {
        title: 'Settings',
        subtitle: 'Central config'
      },
      'changelog': {
        title: 'Changelog',
        subtitle: 'What changed in each version'
      },
      'credits': {
        title: 'Credits',
        subtitle: 'Open-source inspirations'
      }
    },
    changelog: {
      tip: {
        title: '📝 About this page:',
        text: 'The content is bundled with each release; the source file is <code>CHANGELOG.md</code> in the repository root (English UI reads <code>CHANGELOG.en.md</code>). New changes are appended at the <strong>top</strong>, so maintainers only need to edit that file — no UI changes required.'
      }
    },
    quickStart: {
      overview: 'AI-KM is a <strong>local-first desktop AI knowledge platform</strong>: AI chat (RAG Q&A / agent chat), document & whiteboard management, knowledge processing (chunk & embed into a .kb), mastery-based learning with spaced review, a visual workflow editor, Agent Scaffold and multi-agent swarm collaboration, plus a task kanban board inside Knowledge Management — all data stays local by default and works offline. These 6 steps get you started fast:',
      tags: ['AI Chat', 'Knowledge', 'Processing', 'Learning', 'Workflow', 'Agent Scaffold', 'Agent Swarm', 'Kanban Board'],
      step1: {
        title: 'Set Up AI Environment',
        items: [
          '<strong>Local Model (Recommended)</strong>: Install Ollama — visit <a href="https://ollama.com/" target="_blank">ollama.com</a> to download, run <code>ollama serve</code> to start, then <code>ollama pull qwen3</code> to get a model; the <strong>Loaded Models</strong> panel under Settings → LLM → Ollama lists local models (type / effective context / max) and can load or unload them directly',
          '<strong>LM Studio</strong>: Download from <a href="https://lmstudio.ai/" target="_blank">lmstudio.ai</a>, load a model, start local server, select "LM Studio" in Settings, URL <code>http://localhost:1234</code>; the <strong>Loaded Models</strong> panel under Settings → LLM → LM Studio lists every model, its loaded state and the context length set in LM Studio, and can load / unload them directly',
          '<strong>OpenAI</strong>: Select "OpenAI" type in Settings, enter API key, URL <code>https://api.openai.com/v1</code>, models like gpt-4o, gpt-4o-mini',
          '<strong>DeepSeek</strong>: Select "DeepSeek" type in Settings, enter API key, URL <code>https://api.deepseek.com</code>, choose the API style (Chat Completions / Responses API) and model (e.g. deepseek-flash); click "Query" to view the account balance'
        ]
      },
      step2: {
        title: 'Try AI Chat',
        items: [
          'Click the <strong>AI icon</strong> in the left navigation bar to enter the chat interface',
          'Click "New Chat" to create a conversation, select your deployed AI model at the top',
          'Type questions directly in the input box, e.g. "Hello" or "Introduce yourself"',
          'To let AI reference your knowledge base, click the book icon 📚 above the input box and select a .kb file',
          'AI will combine knowledge base content with its answers, supporting multi-turn conversations'
        ]
      },
      step3: {
        title: 'Capture Tasks & Ideas',
        items: [
          'Open <strong>Knowledge Management</strong> in the top navbar and tick <strong>Kanban</strong> in the left panel views',
          'Click <strong>+</strong> on the board status bar (bottom left) to open the new card panel: type a name and a Markdown file is created in the current folder, with the status and start / end dates optional (start defaults to today)',
          'Drag a card into another column to <strong>change its status</strong>, <strong>right-click</strong> a card for archive / set value / delete; the chips filter by value and the status bar "Group" can switch to any attribute',
          'Cards are plain Markdown files: reschedule them in the <strong>Calendar</strong> view, batch-edit attributes in <strong>Table</strong>, and adjust status order / icons from the board status bar'
        ]
      },
      step4: {
        title: 'Learn the concepts & the file types',
        items: [
          'Read <strong>Concepts</strong> first: what an LLM, agent, tool, MCP, skill, knowledge base, PTC and plugin each are — one page clears it all up',
          'Files come in two kinds: <strong>general files</strong> (Markdown / Word / PDF / images / web pages plus Excalidraw whiteboards and draw.io diagrams) and <strong>special files</strong> (<code>.kb</code> knowledge base, <code>.flow.yml</code> workflow, <code>.task</code> scaffold, <code>.data</code> data canvas); double-click to open each with its own view',
          'Need to extend the app? See <strong>Plugins</strong>: add tools to agents, or add a main panel / settings tab / hotkey to the UI'
        ]
      },
      step5: {
        title: 'Try Knowledge Base',
        items: [
          'Go to the <strong>Knowledge Management</strong> module, click "Import" to select local documents (Markdown, PDF, Word, TXT)',
          'For PDF files, it is recommended to use <a href="https://mineru.com.cn/" target="_blank">MinerU</a> to convert to Markdown for better chunking results',
          'Select the folder to process, click "Process" — the system will automatically chunk and vectorize the text',
          'After processing, a .kb knowledge base file is generated, ready to be used in AI Chat or Workflow',
          'Once linked in AI Chat, the AI\'s answers will be based on your document content',
          'Want to edit with colleagues? Try <strong>LAN collaborative editing</strong>: open a file or whiteboard in Knowledge Management, click the collab button to share it with others on the same network and edit in real time (see the "Knowledge Management" section)'
        ]
      },
      step6: {
        title: 'Explore Agent Features',
        items: [
          '<strong>Skills</strong> (Skill Manager / Skill Store / Agent Presets) live under <strong>Settings → Skills</strong> — they no longer occupy their own top-level nav entry: the Store downloads new skills, Manage views/edits skill files, and <strong>Agent Presets</strong> let you create reusable templates and chat as that role',
          'For "write one program that chains several tool calls" use the built-in <strong>PTC Agent</strong> preset (Settings → Agent → Presets → Tools lets you switch any preset\'s <strong>presentation</strong> to PTC): the AI writes a TypeScript program that calls tools through run_code, and the message shows the program, the return value and the tools called inside it — available in chat / workflow / swarm / batch',
          'For multi-agent collaboration switch to <strong>Swarm</strong>: tick several Agent presets as members (manage them in Settings → Agent → Presets) and use <strong>@member-name</strong> to call just one',
          '<strong>Scaffold tasks</strong> are now a file type in Knowledge Management (<code>.task</code>): create one from the right-click “New → Scaffold” menu or double-click an existing <code>.task</code> to open its dedicated “Scaffold” view in a <strong>separate window</strong> (the only scaffold; Batch Agent / Table Reasoning / Collect File / Collect Web are its four presets), and the task can be paused / resumed and keeps running in the background',
          '<strong>Data Canvas</strong> is no longer a top-level module but a <strong>file type in Knowledge Management</strong> (<code>.data</code>): open a <code>.data</code> file from the file tree to enter the canvas module (canvas modeling + form entry + chart dashboards), and changes auto-save back to that file'
        ]
      },
      faq: {
        title: 'FAQ',
        items: [
          { q: 'Q: Chat says "not connected" — what now?', a: 'Go to <strong>Settings → Models → Sources</strong>, check the type and URL / key, then click “Test connection”. For local Ollama / LM Studio make sure the service is running. To make Home use it by default, also click <strong>Set as default</strong>.' },
          { q: 'Q: Processing says the service is not running or the model config is wrong?', a: 'Knowledge Processing follows the global AI config: make sure the active source passes “Test connection / API status”, the model exists, and a <strong>default embedding model</strong> is set (e.g. <code>nomic-embed-text</code>). LM Studio additionally requires that embedding model to be loaded (or Just-In-Time loading enabled).' },
          { q: 'Q: Is my data safe? Can it work offline?', a: 'All chats, knowledge bases and settings stay local and are not uploaded to third parties (apart from the online API requests you configure). With a local model (Ollama / LM Studio) the app works fully offline, and speech recognition can use local ONNX Whisper.' },
          { q: 'Q: Which module should a beginner learn first?', a: 'Suggested order: <strong>Settings</strong> (configure a model) → <strong>Reasoning</strong> (chat) → <strong>Knowledge</strong> (files / kanban tasks) → <strong>Processing</strong> (build a knowledge base) → <strong>Learning</strong> (review & master) → general / special files → plugins.' },
          { q: 'Q: How do I get a PDF into a knowledge base?', a: 'In <strong>Processing → Files</strong>, click “Convert” on a PDF that has no matching md file to generate Markdown, then run chunk → embed → save.' },
          { q: 'Q: Can I use it on my phone?', a: 'Yes. Start sharing in <strong>Settings → Collaboration → Share → LAN share</strong> and open the shown LAN address in a mobile browser to chat. The web page shows the <strong>top navigation bar (including Settings)</strong>, so you can switch panels (Home / Knowledge / Processing / Learning …) just like on the desktop; minimize, maximize, close and the Browser Agent entry are desktop-only and are hidden automatically. To also <strong>browse / edit host files</strong> from the phone, turn on read-only or read &amp; write under <strong>Collaboration → Permissions → File access</strong>: the host does the work and guests can only touch the shared folder set on the Sharing tab, with out-of-scope requests rejected. The web page mirrors the host’s model sources: sources you turned off under Models → Sources are hidden, and model probing runs on the host — so any model the desktop can list, the web page lists too after one click on the model dropdown.' },
          { q: 'Q: Can I use it on my phone without a computer?', a: 'Yes. The Android build can be packaged as an APK (see the Android section in the README) and works <strong>fully offline</strong>, with files kept inside the app sandbox by default. To reach your own data, click “Open folder” and grant a folder through the system dialog (e.g. Documents / my‑notes): files inside it can then be browsed, previewed, edited, created, renamed and deleted, and the grant survives restarts. Opened files show up in an <strong>in-app overlay window</strong> (like Settings), and a <strong>single tap opens a file while a tap on a folder enters it</strong>. The <strong>system back gesture / back key walks the UI stack step by step</strong> — close the top dialog and in-page popovers, then step back inside Settings (content → category list), in Home (chat → chat list) and in Knowledge Management (file-tree drawer), then return to Home; on Home, press twice to exit the app. <strong>Agents run on the phone too</strong>: they can read and write phone files (including granted folders), search knowledge bases, fetch web pages, ask questions and keep plans / todos, with no desktop host required; capabilities that need a desktop (Python, shell, sub-agents, MCP, skills) report that clearly instead of failing silently. Online models (DeepSeek etc.) and <strong>plugins</strong> also need no host: plugins are loaded locally by the app (the plugins folder lives in app-private storage, and “Install” copies a plugin folder from your phone; plugins can also open the system file picker to read phone files), and <strong>window zoom</strong> (Settings → Basic) works and persists on the phone too. LAN models such as Ollama / LM Studio work by entering <code>http://192.168.x.x:11434</code> (cleartext HTTP is allowed). Heavier features — Word/Excel export, the Python sandbox, spreadsheets and the skill library — are not available on the phone.' },
          { q: 'Q: After loading a KB it warns about an unfinished ontology build?', a: 'That is the <strong>resume-from-checkpoint</strong> mechanism: an unfinished ontology build does not continue automatically — click “Continue” in the status bar or on the Wiki page. After clearing the ontology the button should read ▶ Start; if it still says “Continue”, reopen or clear it once more.' },
          { q: 'Q: Why are some entities not linked to any chunk?', a: 'Linking requires the chunk text to contain the entity name verbatim; when the model returns a normalized name that does not appear in the source, the entity is kept as an <strong>isolated concept</strong>. You can add the link manually on the Wiki page.' }
        ]
      }
    },
    concepts: {
      overview: {
        title: 'How this app is put together',
        desc: 'This app assembles <strong>model + tools + knowledge</strong> into an assistant that gets work done. A handful of terms unlock every later section — most of the time they only differ in <strong>which settings page they live on and how you use them in chat</strong>.'
      },
      list: {
        title: 'Eight key concepts'
      },
      items: {
        llm: { name: 'LLM', desc: 'The app’s <strong>brain</strong>: it understands your request and writes the answer. Connect a local model (<code>Ollama</code> / <code>LM Studio</code>, fully offline) or an online one (<code>DeepSeek</code> / <code>OpenAI</code> / <code>Anthropic</code> / <code>Google</code> / <code>Azure</code> / <code>GPUStack</code> / custom) in <strong>Settings → Models → Sources</strong>; chat, processing, learning, workflows and agents all share this global config.' },
        agent: { name: 'Agent', desc: '<strong>An LLM + a role + a set of tools.</strong> It plans steps, calls tools, reads the results and decides what to do next until the task is done. Roles come from <strong>Agent presets</strong> (system prompt / model / tools / skills / knowledge base / MCP); pick one with 👤 on Home to enter agent mode.' },
        tool: { name: 'Tools (tool calling)', desc: 'Capabilities an agent can invoke: read/write files, search the web, open pages, run code, search a knowledge base, and so on. You never click them — the model decides <strong>which tool and which arguments</strong>. Tools with side effects go through the <strong>approval policy</strong>.' },
        ptc: { name: 'Programmatic tool calling (PTC)', desc: 'By default tools are called one at a time; with PTC the model only sees <code>run_code</code> and <strong>writes one TypeScript program</strong> that chains several tools (e.g. loop over 20 files, then summarize). Fewer round trips and cheaper batching — the message shows the program, its return value and the tools called inside it.' },
        mcp: { name: 'MCP (Model Context Protocol)', desc: 'A common way to plug in external tool capability: a bundle of functions exposed as one service that agents / workflows / external clients all call the same way. Six <strong>in-process MCP services ship built in</strong> (Browser Agent / Office docs / drawio / literature search / PostgreSQL / plugin-dev reference); you can also add external servers or expose the built-ins.' },
        skill: { name: 'Skill', desc: 'A <strong>how-to / step-by-step playbook</strong>: one folder plus one <code>SKILL.md</code>. It adds no new tools — it teaches the agent to use what it already has. Trigger it explicitly with <code>$skill-name task</code>, or let the agent match it by description.' },
        kb: { name: 'Knowledge base (.kb) & RAG', desc: 'A searchable index built by <strong>chunking → embedding</strong> your documents. Chat retrieves the most relevant chunks first (<strong>RAG</strong>) and then answers from them — grounded and traceable. Built by <strong>Processing</strong> and used by Home’s KB mode, agents, workflows and the <strong>Learning</strong> module.' },
        plugin: { name: 'Plugin', desc: 'An extension package that grows the app itself: it can <strong>add tools</strong> for agents and <strong>add a main panel / settings tab / hotkey</strong> to the UI. Permissions are declared in its manifest (files / shell / network / session logs / LLM); anything not requested is denied.' }
      },
      more: {
        title: 'A few more recurring terms',
        desc: 'These show up again later — one line each:',
        items: [
          '<strong>Workflow (.flow.yml)</strong>: draw steps such as retrieve → branch → generate → export as nodes and wires, then run the fixed flow in one click (see <strong>Special files</strong>).',
          '<strong>Swarm</strong>: a Home chat mode where several agent presets work on one task as members (see <strong>Reasoning</strong>).',
          '<strong>Ontology graph</strong>: entities + relations extracted from your documents, used for graph Q&A and retrieval boost (see <strong>Processing</strong>).',
          '<strong>Scaffold (.task)</strong>: a general agent execution framework — one file = one repeatable batch task (see <strong>Special files</strong>).',
          '<strong>Data canvas (.data)</strong>: no-code data modeling — define objects and fields on a canvas, then enter data via forms and inspect charts (see <strong>Special files</strong>).'
        ]
      }
    },
    generalFiles: {
      overview: {
        title: 'What are general files?',
        desc: '<strong>General files</strong> are the everyday things you read and write: Markdown notes, Word / PDF documents, images and media, plain text, Excel, local web pages, plus <strong>Mermaid diagrams</strong> (<code>.mmd</code>), <strong>Excalidraw whiteboards</strong> and <strong>draw.io diagrams</strong>. All of them are created and opened in <strong>Knowledge Management</strong>, rendered by whichever view fits best on double-click.'
      },
      views: {
        title: 'General views (11)'
      },
      docs: {
        title: 'Markdown & document editing',
        items: [
          { title: 'Browse', desc: 'Read-only preview: formulas, code highlighting, tables, images, Mermaid and embedded draw.io diagrams all render; the status bar also offers ✨ smart actions (chat about this document) and ⬇ export.' },
          { title: 'Source edit', desc: 'Monaco editor over the raw Markdown (incl. YAML front matter), with AI assistance and drag-and-drop to create reference links; code and data files such as <code>.py</code> / <code>.json</code> open as text here too.' },
          { title: 'Visual edit (blocks)', desc: 'Block-based rich text: type <code>/</code> for the block menu, and the block handle’s “Convert to” switches between heading / list / table / code.' },
          { title: 'Mind map / Presentation', desc: 'The mind map follows heading levels; Presentation turns Markdown into slides (split by <code>---</code> or smart splitting, with outline / full-screen / themes); both turn pages with a left / right swipe on touch screens.' },
          { title: 'Other document types', desc: 'Word is converted to Markdown for preview and can be exported back; PDF supports paging, zoom, OCR and <strong>in-place translation</strong>; Excel becomes a Markdown table; images / video / plain text have their own previews; local web pages (<code>.html</code> / <code>.htm</code>) open in the <strong>built-in browser</strong>.' },
          { title: 'Mermaid diagrams (.mmd / .mermaid)', desc: 'The <strong>Browse</strong> view renders the whole source file as one diagram — click it to zoom, pan and export PNG / SVG; the <strong>Source</strong> view edits the text. A render error shows the message and the source in place; an empty file opens directly in Source view.' },
          { title: 'PDF page management', desc: 'The “Manage pages” button in the PDF status bar turns the document into one-thumbnail-per-page cards: <strong>merge</strong> other PDFs in, <strong>delete</strong> selected pages, <strong>drag to reorder</strong>, and <strong>rotate</strong> a page or the whole selection. Confirming rebuilds the file with pdf-lib — overwrite the original or save as a new PDF (remote previews can only be saved as new).' }
        ]
      },
      export: {
        title: 'Export & print',
        items: [
          'The Browse view’s <strong>export</strong> menu offers Markdown / Word / PDF; Markdown and Word open a save-as dialog (Word also has official-document / Chinese-paper / English-paper / custom styles, with formulas converted to native Word equations first).',
          'draw.io diagrams export to PNG / JPEG / SVG / XML and PDF, and <strong>copy as image</strong> (<code>Ctrl+Alt+X</code>) pastes straight into Word / PPT.',
          'Export and print both go through local channels, so they work <strong>offline</strong>.'
        ]
      }
    },
    specialFiles: {
      overview: {
        title: 'What are special files?',
        desc: '<strong>Special files</strong> are file types defined by this app: each has a dedicated module or editor, and double-clicking one in Knowledge Management opens that view.'
      },
      items: {
        kb: { name: 'Knowledge base .kb', desc: 'The searchable index built by chunking / embedding in Processing; double-click jumps to <strong>Processing</strong> and loads that base.' },
        flow: { name: 'Workflow .flow.yml', desc: 'Node-and-wire process orchestration (a fixed flow you can rerun); double-click opens the <strong>workflow canvas</strong> in its own window.' },
        task: { name: 'Agent scaffold .task', desc: 'One file = one repeatable batch agent task; double-click opens the <strong>scaffold view</strong> in its own window.' },
        data: { name: 'Data canvas .data', desc: 'No-code data modeling: objects + fields + forms + charts; double-click opens the <strong>data canvas view</strong> in its own window.' }
      },
      kb: {
        title: 'Knowledge base file (.kb)',
        items: [
          '<strong>Where it comes from</strong>: open a workspace in <strong>Processing</strong> → Files → Chunk → Embed → Save knowledge base.',
          '<strong>How to use it</strong>: double-clicking a <code>.kb</code> jumps to <strong>Processing</strong> and loads it for search, Q&A and re-chunking; pick it in Home’s <strong>KB mode</strong> for retrieval + answering; agent presets with “access knowledge base” on call it through <code>kb_search</code>; the <strong>Learning</strong> module builds practice and review around it.',
          '<strong>Where it is managed</strong>: one <code>.kb</code> can hold several versions (switch / save from the toolbar); learning records live next to it in <code>&lt;name&gt;.learning</code> and never inside the <code>.kb</code>.'
        ]
      },
      flow: {
        title: 'Workflow file (.flow.yml)',
        desc: 'A workflow wires steps such as model calls, code, HTTP requests, knowledge retrieval and file handling into an automated flow you can run in one click; the flow itself is a <code>.flow.yml</code> file (Dify app DSL — importable into Dify, and Dify exports open here too).',
        items: [
          '<strong>Where it comes from</strong>: ➕ in the file tree → type <strong>Workflow</strong> (creates an empty <code>.flow.yml</code> skeleton).',
          '<strong>How to use it</strong>: double-click to open the workflow canvas in a <strong>separate window</strong> — add nodes, wire them, set parameters in the right-hand panel, then click <strong>Run</strong> to inspect each node’s output; picking the same <code>.flow.yml</code> in Home’s <strong>workflow mode</strong> also runs it node by node.',
          '<strong>Where it is managed</strong>: one file = one flow, so copy / rename it to make variants; a ● after the file name means unsaved changes, and <code>Ctrl+S</code> writes them back.'
        ]
      },
      task: {
        title: 'Agent scaffold task (.task)',
        desc: 'Agent Scaffold is a <strong>general agent execution framework</strong> (called Harness in the app): it runs batch work in a <strong>table-driven</strong> way, and one <code>.task</code> file is one independent task that can be paused, resumed and left running in the background.',
        items: [
          '<strong>Where it comes from</strong>: right-click in the file tree / Files view → <strong>New → Scaffold</strong> (creates an empty <code>.task</code>), which opens in its own window right away.',
          '<strong>How to use it</strong>: pick one of four presets at the top-left of the task page — <strong>Batch Agent Run</strong> (one separate agent per row) / <strong>Table Reasoning</strong> (row-by-row inference to fill fields) / <strong>Collect File</strong> (scan a folder and extract fields) / <strong>Collect Web</strong> (page-by-page scraping with link following) — or combine the three dimensions <strong>source × execution × output</strong> manually.',
          '<strong>Where it is managed</strong>: <strong>Save</strong> at the top of the left column writes back to this <code>.task</code> (<strong>Save as</strong> keeps a copy); Execution & config lets you choose whether graph data / run logs are stored inside the task file.'
        ]
      },
      data: {
        title: 'Data canvas file (.data)',
        desc: 'The data canvas is <strong>no-code data modeling</strong>: build tables / parameters / charts / sub-canvases from nodes and wires, enter data through forms and read results on charts — it is a file type inside Knowledge Management (<code>.data</code>).',
        items: [
          '<strong>Where it comes from</strong>: ➕ in the file tree → type <strong>Data canvas</strong> (creates a <code>.data</code>), or right-click → New → Data canvas; a new file opens as an empty canvas you can model in right away.',
          '<strong>How to use it</strong>: open the <code>.data</code> file in Knowledge Management (Browse / Visual edit render the canvas module, which has its own <strong>Home / Data / Canvas / Help</strong> tabs): place and wire nodes on the Canvas tab, configure per-column form entry on the Data tab, and watch the chart dashboard on Home.',
          '<strong>Where it is managed</strong>: changes <strong>auto-save</strong> back into the <code>.data</code> file after about 1.5 seconds of debounce (💾 in the toolbar saves immediately); the source editor shows the same content as JSON if you want to edit it directly.'
        ]
      }
    },
    plugins: {
      overview: {
        title: 'What is a plugin?',
        desc: 'A plugin is an extension package that grows the app itself: it can <strong>add tools</strong> for agents and <strong>add a main panel / settings tab / settings card / global hotkey</strong> plus bilingual string tables to the UI, so your own scripts and team tools plug into AI-KM. Find them under <strong>Settings → Plugins</strong>, split into <strong>Manage / Store / Develop</strong>.'
      },
      capabilities: {
        title: 'What plugins can do',
        items: [
          '<strong>Add tools</strong>: tools a plugin registers join every agent’s tool set automatically (switch them off per preset on the Tools page; disabling the plugin removes them instantly) and can never clash with built-in names.',
          '<strong>Add UI</strong>: a main panel (appears in the nav like Home / Knowledge), settings tabs, settings cards and swarm-workbench tabs; all of them disappear the moment the plugin is disabled or removed — if you were on that panel the app returns to Home.',
          '<strong>Call host capabilities</strong>: <code>ctx.llm</code> to run a chat on a configured source / model, <code>ctx.files</code> to pick files, read text / tables / binary or open the built-in viewer, and <code>ctx.app.agentPresets()</code> to read the agent preset list.',
          '<strong>And more</strong>: register global hotkeys (never inside text inputs), ship bilingual string tables, post notifications, and read / write their own config.'
        ]
      },
      manage: {
        title: 'Install & manage (Settings → Plugins → Manage)',
        overview: 'A plugin package is just a folder with an <code>aikm</code> manifest in <code>package.json</code>. Drop it into the plugins folder and it is discovered — freshly written plugins load within about a second, no restart needed.',
        items: [
          { title: 'Put it in the right place', desc: 'The plugins folder defaults to <code>plugins</code> inside your user-data directory and can be changed with “Choose plugins folder”. Subfolders are supported (scanned up to 4 levels deep, skipping hidden folders and <code>node_modules</code>), or click ➕ to install from any folder.' },
          { title: 'The folder name must be a valid plugin id', desc: 'The folder name must equal the manifest’s <code>aikm.id</code> and use only ASCII lowercase <code>[a-z0-9._-]</code>; a folder with <strong>Chinese characters / uppercase / spaces</strong> is <strong>skipped entirely</strong> (it never shows up in the list). Put display text in the manifest’s <code>aikm.name</code>.' },
          { title: 'Confirm permissions on enable', desc: 'Enabling or changing a plugin first shows a confirm dialog listing the permissions it requests; disabling it revokes everything it had.' },
          { title: 'Everyday actions', desc: 'Enable / disable / reload (unregisters then runs again — no restart after editing UI code) / logs / config (JSON passed to the plugin, applied on reload) / details / remove; the data button shows and clears the plugin’s storage usage.' }
        ]
      },
      store: {
        title: 'Store (install from a shared folder)',
        desc: 'Point the store at the folder shared under <strong>Settings → Collaboration → Share</strong>: paste the <code>remote-fs://…</code> address (or click “local shared folder”) and it scans for plugins and skills with one-click install, listing the requested permissions first. Publishing is just dropping a plugin folder into the shared folder — <strong>no index file to write</strong>.'
      },
      dev: {
        title: 'Develop (where to start writing plugins)',
        desc: 'No need to read the source first: copy the whole “general development prompt” from <strong>Settings → Plugins → Develop</strong> into any model, describe what you want, and drop the returned files into the plugins folder. You can also pick the <strong>plugin development agent</strong> in chat — it is bound to the built-in MCP service <code>builtin-plugin-dev</code>, fetches the official reference on demand and self-checks against the host’s real load status before delivering.',
        items: [
          'The page ships: how to use plugins (install → confirm permissions → where panels / tools / hotkeys appear → config → troubleshooting → removal, copyable), a minimal plugin from scratch, copyable prompt templates (UI plugin / tool plugin / model & file capability / troubleshooting), a manifest, slot and API cheat sheet, and an FAQ (load failures, undeclared slots, white-on-white in dark theme, and so on).',
          'The repository’s <code>examples/plugins/hello-panel</code> is a ready-to-copy sample plugin (tool + UI + hotkey + bilingual strings).'
        ]
      },
      perms: {
        title: 'Permissions & safety',
        items: [
          '<code>fs</code> file read/write (tools with this permission need approval by default), <code>shell</code> run commands (still bound by the trusted policy), <code>net</code> network requests, <code>agent</code> read-only session logs, <code>llm</code> call your configured sources and models (consumes quota / compute); <strong>anything not requested is denied</strong>.',
          'If a plugin’s UI crashes it shows “extension error” with a retry button in place, while the rest of the app keeps working.'
        ],
        note: {
          title: '⚠️ Only enable plugins you trust',
          text: 'Plugins run in the same process as the host (the UI half shares the main page) and are <strong>not protected by the workspace sandbox</strong>: plugin code can do anything the host can. Permission declarations are for transparency and accident prevention only.'
        }
      }
    },
    aiChat: {
      tasks: {
        title: 'What each mode is roughly for',
        normal: {
          items: [
            'Everyday Q&A: general questions, explaining concepts, brainstorming.',
            'Writing & polishing: rewriting, summarizing, translating, proofreading.',
            'File context: upload files/images (or drag files straight into the chat window) and ask AI to answer or summarize from them.',
            'Live info: with a web-search model enabled, questions auto-search the web and list clickable sources.'
          ]
        },
        retrieval: {
          items: [
            'Fact-checking: ask about your own documents; answers trace back to source chunks (reference slices).',
            'Strategy-based retrieval: pick Similarity / File Enhance / Question Enhance / Ontology Enhance / Multi-hop / Community / Agentic as needed.',
            'Cross-document tasks: compare multiple documents, synthesize topics, find gaps.',
            'Long-document Q&A: after chunking & embedding, big documents can be answered precisely.'
          ]
        },
        workflow: {
          items: [
            'Repeated batch tasks: run the same “crawl → retrieve → analyze / summarize” pipeline many times.',
            'Automation: turn manual steps into a visual flow — one-click run, reusable anytime.',
            'Data processing: read CSV/JSON → structure → LLM fill → export.',
            'Composition: chain text / inference / knowledge / code / iterate & aggregate nodes.'
          ]
        },
        agent: {
          items: [
            'Task execution: not just answers but hands-on work — reading/writing files, organizing, producing artifacts.',
            'Research & synthesis: gather from search + web + knowledge bases into a finished draft.',
            'Skills / MCP: type $skill-name or describe capabilities to do domain tasks.',
            'Autonomous planning: break down multi-step tasks, retry on failure, run until done (with a visible task list).'
          ]
        },
        code: {
          items: [
            'Multi-step composition: write search → read → loop → summarize as one program instead of many separate tool calls.',
            'Batch loops: process a list of files / URLs / queries inside the program (a plain for loop), saving many round trips.',
            'Data crunching: filter, aggregate and compute statistics over tool results before returning them.'
          ]
        },
        swarm: {
          items: [
            'Multi-perspective comparison: different members give their own take on the same proposal so you can weigh trade-offs.',
            'Divide and conquer: tick members like “researcher / analyst / reviewer” so each covers part of one task.',
            'Structured debate: for decisions, let members rebut over rounds and have the host summarize neutrally.',
            'Named follow-up: use @member-name to call a single member to dig deeper into a specific result.'
          ]
        }
      },
      concept: {
        title: 'Core Concepts',
        lead: 'Smart Chat is built on these core ideas (one capability per point):',
        items: [
          '<strong>① Local-first · Multi-model</strong>: runs locally and offline by default; switch between many model providers.',
          '<strong>② Multiple chat modes</strong>: Normal / Knowledge Base / Workflow / Agent / Swarm — tasks range from Q&A to execution and multi-agent collaboration; an agent can additionally use the <strong>PTC presentation</strong> (programmatic tool call) for multi-step work written as one program.',
          '<strong>③ RAG is just one piece</strong>: Knowledge Base mode first searches your documents, with ontology / question-enhance / multi-hop / community strategies — but that is not all.',
          '<strong>④ Tools & Agents</strong>: Agents can read/write files, search, browse the web, query knowledge bases, invoke skills and MCP.',
          '<strong>⑤ Local data</strong>: chats, .kb, .learning and .flow.yml all live locally — private and offline-ready.'
        ]
      },
      schemes: {
        title: 'Five Chat Modes',
        normal: { name: 'Normal Chat', desc: 'Chat directly with AI; upload files/images as context (you can also drag files straight into the chat window). Ideal for everyday questions and writing; with a web-search-capable model (e.g. DeepSeek) questions can auto-search the web and list sources.' },
        retrieval: { name: 'Knowledge Base QA', desc: 'Link a .kb knowledge base; AI answers from your documents (RAG), showing reference chunks below. You can pick a retrieval strategy above the input (Similarity / File Enhance / Question Enhance / Ontology Enhance / Multi-hop / Community / Agentic, etc.). In this mode, dropping a .kb file into the chat window links it as the knowledge base.' },
        workflow: { name: 'Workflow Chat', desc: 'Link a .flow.yml / .flow.yaml workflow file (open the same file in Knowledge Management to author it on the canvas — see the Workflow tab); enter start text to trigger the flow: every node becomes an expandable step card (icon / status / params / output, same style as Agent mode) and the final output follows the steps.' },
        agent: { name: 'Agent Chat', desc: 'Pick the "Agent" mode in the input bar: choose an Agent preset via 👤, or chat with the general agent. The AI plans autonomously and invokes tools (read/write files, search, browse the web, KB retrieval, skills, MCP, etc.); typing $skill-name triggers a skill directly. <strong>Image uploads</strong> (multimodal, needs a vision-capable model) and text attachments are supported too. The input box stays available <strong>while it runs</strong>: keep typing and press Enter to send <strong>guidance</strong> (the run is not interrupted; the agent picks it up at its next step). <strong>PTC (programmatic tool call)</strong> is a presentation this mode offers: set a preset\'s presentation to PTC (the built-in <strong>PTC Agent</strong> already is), and instead of calling tools one by one the model writes a TypeScript program that calls them through <code>run_code</code> — the message shows the program as a code block plus the return value, console logs and the <strong>tools actually called inside it</strong>. Great for multi-step loops and batch work, and it also applies to workflow / swarm / batch.' },
        swarm: { name: 'Swarm Chat', desc: 'Pick the "Swarm" mode in the input bar: tick <strong>multiple Agent presets</strong> as members and let them collaborate on one task (respond in turn / debate / team); use <code>@member-name</code> to call a single member. Replies and tool calls render exactly like Agent mode. You can also send <strong>guidance</strong> mid-run (Enter) — it goes to the member currently speaking.' }
      },
      guide: {
        title: '4-Step Guide',
        step1: {
          title: 'Install Ollama (Recommended)',
          items: [
            'Visit <a href="https://ollama.com/" target="_blank">ollama.com</a>',
            'Run <code>ollama serve</code>',
            'Run <code>ollama pull qwen3</code>'
          ]
        },
        step2: {
          title: 'Start a Chat',
          items: ['Click "New Chat"', 'Select model (e.g., qwen3)', 'Start chatting']
        },
        step3: {
          title: 'Connect Knowledge Base',
          items: ['Click book icon 📚', 'Select .kb knowledge base', 'AI will automatically reference it']
        },
        step4: {
          title: 'Export Chat to Knowledge',
          items: [
            'Click the <strong>Save/Export</strong> button in the chat history area',
            'Save as Markdown file, automatically stored in the knowledge management directory',
            'Open in the <strong>Browse</strong> or <strong>Edit</strong> view of Knowledge Management for further editing and organization'
          ]
        }
      }
    },
    knowledge: {
      overview: {
        title: 'What is Knowledge Management?',
        description: 'The Knowledge Management module (knowFile) is a <strong>multi-view desktop file manager</strong> that lets you browse, edit, and organize your local files in various formats. It provides separate-window file browsing, multi-view switching, and full-text search capabilities.'
      },
      fileTypes: {
        title: 'File types & views',
        overview: 'Knowledge Management is the app’s file centre: the file tree on the left (local and remote workspaces), the active view on the right, and one toolbar for path and search. Files come in two kinds and there are 11 views in total — this section just introduces them, each tab has the details.',
        views: {
          title: '11 views',
          desc: 'Opening a file gives you <strong>Browse / Source edit / Visual edit / Mind map / Presentation</strong>, plus six global views — <strong>Files / Graph / Kanban / Calendar / Map / Table</strong> — switched with the “view” dropdown in the toolbar. The default view is set in <strong>Settings → Features → Knowledge Management</strong>.'
        },
        general: {
          title: 'General files',
          desc: 'Markdown, Word, PDF, images and media, plain text, Excel, local web pages, plus Excalidraw whiteboards and draw.io diagrams — see the <strong>General files</strong> tab.'
        },
        special: {
          title: 'Special files',
          desc: '<code>.kb</code> knowledge base, <code>.flow.yml</code> workflow, <code>.task</code> agent scaffold and <code>.data</code> data canvas — each has its own view, see the <strong>Special files</strong> tab.'
        }
      },
      views: {
        title: 'Views (11 views + 5 dedicated views)',
        groupViews: '11 views',
        groupFileViews: '5 dedicated views (file-specific / special files)',
        browse: { name: 'Browse', desc: 'The unified preview view (default): Markdown renders formulas, highlighted code, tables, images, Mermaid diagrams and embedded draw.io diagrams (![](diagram.drawio) is drawn inline and can be clicked to open the editor; Browse / Visual / Mind Map / Presentation all render it, multi-page diagrams render page by page and #page=2 pins a page); Word, PDF, images and media have their own previews too. The bottom status bar also offers Smart actions (chat with the document) and export to Markdown / Word / PDF.' },
        edit: { name: 'Source', desc: 'Monaco code editor: edit Markdown source and YAML front matter directly, with AI help and drag-and-drop images / files that become reference links; code and data files (.py, .json, .flow.yml …) open here as plain text too.' },
        blockedit: { name: 'Visual', desc: 'Block editor (WYSIWYG): edit block by block and type / for the block type menu (headings, lists, to-dos, tables, code, formulas …); the block handle menu’s “Turn into” converts a block to another type, so you never need Markdown syntax. Embedded draw.io diagrams (![](diagram.drawio)) are drawn inline.' },
        mindmap: { name: 'Mind Map', desc: 'Mind map view: turns the Markdown heading hierarchy into a zoomable, level-by-level collapsible map (LaTeX math supported; display formulas and paragraphs containing math become their own nodes); node text width and expand level are adjustable in the status bar. The ▶ button in the status bar starts talk mode, where ← / → or a touch swipe drills down and back up level by level. Embedded draw.io diagrams (![](diagram.drawio)) are drawn as images inside their node.' },
        files: { name: 'Files', desc: 'Files view: browse the current folder as a grid or list (Ctrl+wheel scales icons continuously; the smallest size is list mode) with multi-select, rubber-band selection and keyboard navigation; audio / video files show cover thumbnails; filter by YAML attribute (incl. status) in the status bar; the right-click menu offers open / rename / delete / copy / cut / paste / reveal in folder / sort (name, modified, size, type) / display (file names, aspect ratio), and right-clicking empty space also sorts, switches display options and creates Markdown, Excalidraw and workflow files or folders.' },
        kanban: { name: 'Kanban', desc: 'Kanban task management: a card is one Markdown file in the current folder (the one shown in the top breadcrumb); group cards by any attribute (status by default); click + on the status bar (bottom left) to open the new card panel (a name is all you need, plus optional status and start / end dates; 开始时间 defaults to today, so the card shows up in Calendar / Gantt right away), drag a card into another column to change that attribute, cards show their start / end dates and the calendar icon on a card (or right-click → Set dates) sets them (the date text itself is read-only) and a right-click menu sets the color (a preset palette per theme — one for light, one for dark — plus the system picker and clear) / renames / archives / sets a value / deletes; cards refresh automatically when a file\u2019s attributes change elsewhere (Table view, source editor, external editor); when the panel is too narrow for two columns side by side the columns stack vertically; the status bar can filter by the group field\u2019s values (multi-select panel with per-value counts, wrapping and scrolling) as well as switch board / list, read depth and whether archived cards show, and the status categories (order / icons, shared with Calendar) can be edited; values that only exist in your files are listed at the bottom of that panel and can be added to the categories in one click to take part in the order' },
        graph: { name: 'Graph', desc: 'File relationship graph: folder hierarchy and file references at a glance (auto-refreshes on file changes; click a node to highlight its related nodes, drag nodes to adjust the layout; double-click a node to open the file exactly like the file tree — always in a separate window, with special files dispatched to their own module)' },
        calendar: { name: 'Calendar', desc: 'Month / week / year / Gantt in one: date ranges (multi-day entries span every day), colors & status icons, in-view search, drag to reschedule, create in a date cell (created in the current folder); Markdown files only, and only Markdown can be dragged to reschedule; right-click an entry for open / rename / set dates / color (a preset palette per theme, plus the system picker and clear) / archive / copy path / reveal in folder / delete — the same menu as on Kanban cards, also available in the day list dialog — and the status bar archive icon controls whether archived entries show (hidden by default)' },
        map: { name: 'Map', desc: 'Plots files on a map from their 纬度 / 经度 YAML attributes (one click to show geo-tagged files only); click a marker or a row in the side list to open the file. Maps need no search, so the toolbar only shows the path.' },
        table: { name: 'Table', desc: 'One row per file, one column per YAML attribute: Markdown only by default (switch to All — non-Markdown rows are read-only), and columns come from the attributes inside the current "depth" range (change the depth or the folder and the columns follow, with no leftover all-empty columns; collapsed attributes can be added back from the bottom of the Columns panel, whose "+" also adds a column manually). Click a header to sort (asc / desc / off), and use the column menu to filter by value (incl. "unset") / set the editor type / rename the attribute / hide the column; columns can be reordered and resized by dragging, and order / width / type / sort / filter are all remembered. Cells edit by attribute type (text / number / date / date-time / checkbox / color / select / tags, with the Status attribute using the status taxonomy values and icons), with arrow-key navigation, Enter to edit / Esc to cancel / Delete to clear and Excel block paste; row checkboxes allow batch attribute setting / removal or file deletion, and the row right-click menu offers open / open folder / open in new window / reveal in folder / copy path / new sibling / rename / delete' },
        presentation: { name: 'Presentation', desc: 'Turns Markdown into slides: pages split on --- or by smart splitting (by headings / blank lines, skipping code blocks), with an outline / overview grid, full-screen presenting, auto and 16:9 / 4:3 ratios and 6 slide themes; front-matter title / keywords / summary build a cover slide automatically. Images are laid out by shape (slide-shaped figures get their own page, portrait ones sit beside the text, wide ones above/below it, and multiple images pick a column count or one page each), long text is paginated with the font size auto-fitted to fill the page, over-long tables are trimmed with an omitted-row note, and Ctrl + wheel zooms in on a single page. On touch screens, swipe left / right to turn pages.' },
        excalidraw: { name: 'Whiteboard', desc: 'Excalidraw infinite canvas (.excalidraw files only): hand-drawn shapes / arrows / text / free draw; changes are written back to the file automatically (Ctrl+S saves at once) and nothing else needs installing' },
        drawio: { name: 'Diagram', desc: 'draw.io diagram editor (.drawio / .dio files only): flowcharts, architecture, UML and ER diagrams; the editor is built in, with no separate draw.io install and no network' },
        flow: { name: 'Workflow', desc: 'Workflow files (.flow.yml / .flow.yaml, a file-specific view): the file is a Dify app DSL, opened as a workflow editor in the Browse / Visual views where you can author, run and read the run logs; the Source view shows the YAML text' },
        kb: { name: 'Knowledge Base', desc: 'Knowledge base files (.kb) hold the chunks and index produced by knowledge processing (RAG) and are fairly large. Double-clicking does not open a file view but jumps to Knowledge Processing and loads the base for search, Q&A and re-chunking' },
        task: { name: 'Scaffold', desc: 'Scaffold task files (.task, a file-specific view): one .task = one standalone task — double-click to open the scaffold canvas in a separate window (import a table, run, and review graph / logs / results there), and both configuration and results are saved back to that file; legacy scaffold .task files convert automatically' }
      },
      features: {
        title: 'Core Features',
        step1: { title: '📂 File Browsing', desc: 'File tree on the left shows directory structure. Expand / collapse with the arrow on the left of a node (a plain click no longer opens or closes it); on desktop, click / double-click a file to open it in a separate window (open several windows side by side for comparison), while on Android / the web it opens in an in-app overlay window above the main UI (same idea as Settings; on Android a single tap opens a file and a single tap on a folder enters it). Double-clicking a folder brings every view on the right (Files / Kanban / Table / Graph / Map / Calendar) to that folder. The context menu adapts to the node: on a file, "Open" lists the views directly while "Actions" holds Reveal in Folder / Copy Path / System; on a folder or the empty area, "New" creates a folder / Markdown / Excalidraw / draw.io / workflow / data-canvas / scaffold / Word / Excel / PPT file (the Office types get a blank document skeleton written in, so they are ready to edit), plus Copy / Paste (clipboard shared with the file view) / Rename / Delete.<br>In a tall window (aspect ratio above 16:9, e.g. a phone in portrait) there is no longer a side-by-side split: the file tree becomes a <strong>full-screen drawer</strong> (open it with the leftmost toolbar switch, close it with the ← inside it or by tapping a folder / file) and the view on the right always fills the screen.' },
        step2: { title: '🔄 Multi-View Switching', desc: 'The same file can be viewed in different modes: Browse (rendered), Edit (source), Visual edit (block / WYSIWYG), Mindmap, Presentation; <strong>Word / Excel / PPT</strong> additionally offer <strong>Office edit</strong> — a real, embedded office suite that edits the document in place and saves a standard Office file (it is the default view for those types). You can enable/disable views in Settings.' },
        step3: { title: '🔍 Full-Text Search', desc: 'The top search bar searches filenames and full text to quickly locate files. Double-click a result to open it in a separate window; the search panel stays open so several results can be opened in a row (close it with Esc or ✕).' },
        step4: { title: '🏷️ Organization', desc: 'Filter files by YAML attribute (status and more), group and capture on the "Kanban" view (each card is a Markdown file, drag to change an attribute), review and tidy attributes column by column in the "Table" view (sort / filter / batch edit / block paste; its columns come from the attributes inside the current depth), track project timelines with the Calendar view\u2019s Gantt mode, and explore file relationships in the Graph. Except Files, every global view reads the folder selected on the left and they all share one top toolbar (a single bar even when several views are side by side): a leftmost show / hide left panel switch + a view selector + back / forward / up / refresh + a clickable path breadcrumb + a shared search box (when the toolbar gets very narrow the nav buttons and breadcrumb collapse; the Alt+← / Alt+→ / Backspace shortcuts still work) whose syntax is identical everywhere (keywords match file name / path / attribute values, plus 状态:todo or 优先级>2); the bottom status bar keeps only each view\u2019s own settings and counters.' }
      },
      smart: {
        title: '🧠 Document Smart Actions & Word Export',
        overview: 'The <strong>bottom status bar</strong> of the Browse view (Markdown / Word / plain text) offers two power features: <strong>chat with the current document</strong> and <strong>export to Markdown / Word / PDF</strong>.',
        step1: {
          title: 'Chat with the document (Smart actions)',
          desc: 'Click the ✨ <strong>Smart actions</strong> icon at the far right of the status bar to open the chat panel. Tick the <strong>context attachment</strong> first: <strong>Whole document (default)</strong> / <strong>Current section</strong> / <strong>Selected text</strong> — the AI answers only from that content, so replies stay on topic. The panel width can be dragged (about 260–640px); answers stream and can be stopped at any time.'
        },
        step2: {
          title: 'Export Markdown / Word / PDF',
          desc: 'Click the ⬇ <strong>Export document</strong> icon in the status bar: the menu offers “Export Markdown”, “Export Word” and “Export PDF”. <strong>Export Markdown</strong> also opens a <strong>save-as dialog</strong> (defaults to the folder of the current file) and reports the saved path.'
        },
        step3: {
          title: 'The Word “Save as” dialog',
          desc: 'Choosing “Export Word” opens a <strong>save-as dialog</strong>: pick an <strong>export style</strong> — Official (GB/T 9704-2012, default) / Chinese Paper / English Paper (APA 7) / <strong>Custom .docx template</strong> — and choose the <strong>save location</strong> (defaults to the folder of the current file). Formulas, tables, images, Mermaid diagrams and embedded draw.io diagrams are exported as well (formulas prefer editable native Word equations).'
        },
        step4: {
          title: 'Other export entry points & default style',
          desc: 'The same Word export is also used by <strong>Home chat</strong> (right-click the message area → Export → Word) and the <strong>Swarm run result panel</strong>. The default template and custom style file live under <strong>Settings → General → Other → Word Export</strong>.',
        },
        note: {
          title: '📌 Tip:',
          text: 'Attached context is capped at <strong>about 120,000 characters</strong>; when exceeded, both the input area and the sent bubble <strong>explicitly warn that it was truncated</strong> (nothing is dropped silently). PDF smart actions use the same panel, with attachments for “current page text / full text / current page image”.<br><strong>PDF translation</strong>: select text and <strong>right-click → Translate</strong>, or click the <strong>translate icon</strong> at the bottom right to overlay Chinese; <strong>pages you scroll to are translated automatically</strong> (the whole document is either overlaid on every page or on none — never half translated). Click the icon again to show the original throughout. The translation is laid <strong>on top of the original text block by block</strong> (per column in two-column papers, per cell in tables, never covering the neighbouring column); original first-line and hanging indents are reproduced, and short translations expand line height and centre vertically to fill the original paragraph. Formulas are rendered with KaTeX from LaTeX. The target language follows the app language; right-click the icon to pick the source and model (defaults to the system default source), and the popover also offers <strong>Clear translation cache</strong>.'
        }
      },
      openMode: {
        title: '🪟 File Opening (Separate Window)',
        overview: 'In Knowledge Management, <strong>double-clicking a file</strong> always opens it in a <strong>separate window</strong>; the former “Open Inside” mode (main-window tab bar, view manager panel) has been removed:',
        newWindow: {
          name: '🪟 Separate Window',
          desc: 'Double-clicking a file opens it in a <strong>separate window</strong>, which offers the views that the file type actually supports (Markdown: all five; CSV: Browse + Source; workflow / data canvas / scaffold / images / audio-video / PDF: a single fixed view, so no view dropdown), and the window title shows "filename - view"; <strong>hovering the file name in the title bar shows its absolute path</strong>. Markdown with no body (an empty file, or one that only has a YAML header — e.g. a card created on the Kanban board) opens in <strong>Source view</strong> by default instead of a blank rendered view. Multiple files can be opened in different windows at the same time, <strong>side by side</strong>, without affecting the main window.'
        },
        effect: {
          title: '🔧 Impact on Operations',
          items: [
            '<strong>Double-click location</strong>: always a separate window; the main window only hosts the global views (Files / Graph / Kanban / Calendar / Map / Table)',
            '<strong>Tab bar</strong>: the main window has none; the file-tree panel top is the "Add Workspace / Open File / Search / Create File" button group',
            '<strong>View switching</strong>: the main window switches global views from the top toolbar (right of the collapse icon on the left), while a file window switches that file\u2019s own views from its top-left',
            '<strong>Multi-file comparison</strong>: arrange files side by side in separate windows, each keeping its own views'
          ]
        },
        note: {
          title: '📌 Tip:',
          text: 'The following stay unchanged: right-clicking a file lists its views directly under "Open" (Read / Source / Block Edit / Mind Map / Presentation, per file type), while Reveal in Folder / Copy Path / System live in the sibling "Actions" submenu; knowledge-base (.kb) files always jump to the Knowledge RAG module; scaffold (.task) files always open their dedicated “Scaffold” view in a separate window; local web pages (.html / .htm) always open in the built-in browser; single-clicking a remote file still previews it in the main window, and double-clicking opens a separate window.'
        }
      },
      drawio: {
        title: '📐 draw.io Diagrams (.drawio / .dio)',
        overview: 'Knowledge Management embeds the <strong>draw.io diagram editor</strong> (the official draw.io webapp is bundled, <strong>fully offline</strong>): <code>.drawio</code> / <code>.dio</code> files (plus <code>.xml</code> whose content contains <code>&lt;mxfile&gt;</code>) open the canvas directly in any of the <strong>Browse / Source / Visual / Mind Map / Presentation</strong> views — for flowcharts, architecture, swimlanes, ER and UML diagrams, with no separate draw.io install and no network.<br>In Markdown, referencing a diagram as <code>![](diagram.drawio)</code> makes <strong>Browse / Visual / Mind Map / Presentation</strong> draw it right inside the document (clicking a diagram opens the editor <strong>on that very page</strong>). Multi-page diagrams are embedded <strong>page by page</strong> (only the first 10 pages if there are more; a mind map node shows the first page); write <code>![](diagram.drawio#page=2)</code> to show a single page (page name works too: <code>#page=name</code>). Word / PDF export includes the diagrams as well.',
        step1: {
          title: 'Create & open',
          desc: 'In the file tree <strong>➕ Create file</strong> dialog switch the type to <strong>draw.io</strong> (a blank diagram skeleton is written), or right-click a folder in the file tree and pick <strong>New → draw.io</strong>; double-click a <code>.drawio</code> file to open the diagram view.'
        },
        step2: {
          title: 'Edit & save',
          desc: 'The canvas matches draw.io desktop (shape library on the left, format panel on the right, page tabs at the bottom). Edits are <strong>not auto-saved</strong> (an <strong>orange dot</strong> appears on the save button while there are unsaved changes); click 💾 at the bottom-right or press <code>Ctrl+S</code> to write the file and see a confirmation. Switching tabs, changing the theme or closing the window still saves silently so nothing is lost. Saving notifies other windows and previews to refresh.'
        },
        step3: {
          title: 'Export / Save as / Print',
          desc: 'Menu “File → Export as” supports PNG / JPEG / SVG / XML etc. “Download” and “Save as to device” now use a <strong>native save dialog</strong> so you choose the location (defaults to the diagram folder) instead of silently dropping into the system Downloads folder. <strong>“Export as → PDF” and “File → Print” go through the app’s local print channel</strong> (offline, current page only; Print opens the system print dialog). “File → Save as” writes a new <code>.drawio</code> file.'
        },
        step4: {
          title: 'Smart actions (AI creates / adjusts / deletes shapes)',
          desc: 'Click ✨ <strong>Smart actions</strong> at the bottom-right to open the AI panel and describe what you want in natural language (for example “add a three-step approval flow: submit → review → archive”). The AI reads the current diagram, generates an incremental fragment and <strong>previews it right on the canvas</strong> (the panel lists the added / updated / deleted items): click “Apply” to write the file or “Cancel” to restore. It can <strong>add</strong> shapes and edges, <strong>adjust</strong> an existing item’s position / size / label / style / z-order / connections, or <strong>delete</strong> cells by id. For multi-page diagrams it only reads and updates the <strong>currently open page</strong> and stays on that page after preview or cancel.'
        },
        step5: {
          title: 'Two smart-action modes',
          desc: 'The mode dropdown next to the input box: <strong>Auto</strong> (default; may add, adjust and delete) / <strong>Add only</strong> (only adds new shapes and edges, never touches existing content, and places new shapes in free space automatically). In a collaboration session only the host can run smart actions, and all members are re-synced afterwards.'
        },
        step6: {
          title: 'Copy as image (paste into Word / PPT)',
          desc: 'Click 📋 <strong>Copy as image</strong> at the bottom-right (shortcut <code>Ctrl+Alt+X</code>) to put the diagram on the system clipboard: choose <strong>High 4× (default) / Normal 2× / Original 1×</strong>, then press <code>Ctrl+V</code> in Word, PowerPoint or any chat window — <strong>no need to save the file first</strong>. The image has a <strong>white background</strong> and is laid out at the diagram’s original size (higher resolution will not blow it up on the page) and stays sharp after pasting; very large diagrams are scaled down automatically to avoid stalls. Only the <strong>current page</strong> is copied, with images and multi-line labels rendered as seen on the canvas.'
        },
        note: {
          title: '📌 Tip:',
          text: 'The diagram runtime (about 60MB) is fetched by <code>scripts/fetch-drawio-webapp.mjs</code> and bundled with the app. Remote <code>.drawio</code> files and read-only members in a collab session open it as a <strong>read-only preview</strong> (padlock badge) — download locally to edit. For multi-page diagrams, PDF / print output covers the <strong>current page</strong> only.'
        }
      },
      collab: {
        title: '🤝 LAN Collaborative Editing (Featured)',
        overview: 'On the <strong>same local network</strong>, multiple computers can <strong>edit the same file in real time</strong> — <strong>Code / Markdown editor</strong>, <strong>Excalidraw whiteboard</strong> and <strong>draw.io diagrams</strong> are all supported. Powered by <strong>Yjs CRDT</strong> plus incremental patches (draw.io uses the official diffSync) for element-level real-time sync: edit on one side and it appears instantly on the other, with <strong>member cursors, name badges</strong> and a member list.',
        step1: {
          title: 'Enable Collaboration',
          desc: 'Go to <strong>Settings → Collaboration → Collaborative Editing</strong>, turn on the "<strong>Enable Collaboration</strong>" switch, then click "<strong>Start Collab Service</strong>". You can configure the port (default <code>3346</code>), max members, edit permission, and room token.'
        },
        step2: {
          title: 'Share a File / Whiteboard / Diagram',
          desc: 'In the code editor status bar at the bottom, or the <strong>collaboration button at the bottom-right of the Excalidraw whiteboard / draw.io diagram</strong>, click "Share" to generate a join URL (<code>ws://IP:port/collab/room?token=…</code>). Send this URL to other members on the LAN.'
        },
        step3: {
          title: 'Join a Session',
          desc: 'Other members open the same file, click the collaboration button → "Join", paste the URL, and enter a nickname. Once joined, you see each other\'s cursors, name badges, and edits in real time, and can <strong>sync the host\'s viewport position and zoom</strong>.'
        },
        step4: {
          title: 'Permissions & Saving',
          desc: 'Three permission modes: <strong>Open</strong> (everyone can edit, default) / <strong>Approve</strong> (read-only members can request edit rights, approved by the host) / <strong>Read-only</strong> (only the host can edit). <strong>Only the host saves to disk</strong> (auto-save interval configurable); members who leave do not lose the synced content.'
        },
        step5: {
          title: 'Diagram collaboration (.drawio)',
          desc: 'draw.io collaboration uses the official <strong>incremental sync (diffSync)</strong>: each edit broadcasts only a patch, so every canvas updates instantly without overwriting one another. <strong>Only the host writes to disk during a session</strong>, and when a new member joins the host exports the authoritative diagram content as the common baseline. Smart actions (AI) can also only be started by the host, and all members are re-synced afterwards.'
        },
        note: {
          title: '📌 Tip:',
          text: 'All members must be on the same LAN and able to reach the port; start the collab service in Settings before first use. The whiteboard syncs embedded images etc. in real time; the code editor shows member cursors and selection highlights; draw.io diagrams merge edits as incremental patches (other members’ cursors are not shown).'
        }
      },
      remoteFs: {
        title: '☁️ Remote File Sharing (Shared Folder)',
        overview: 'With a <strong>shared folder</strong>, you can <strong>read-only share</strong> a local folder to other computers on the LAN: they add it as a <strong>remote workspace</strong> in Knowledge Management (cloud icon, always at the bottom of the local workspaces) to browse and <strong>preview</strong> its files — supporting <strong>Markdown / text / PDF / image / Word</strong>; download to edit.',
        step1: {
          title: 'Host: Share',
          desc: 'In <strong>Settings → Collaboration → Sharing</strong>, start the shared-folder service, choose the shared directory, configure the port (default <code>3347</code>) and token, then copy the link (<code>remote-fs://IP:port?token=…</code>) to other LAN members.'
        },
        step2: {
          title: 'Client: Add Remote Workspace',
          desc: 'Right-click the empty area of the file tree in <strong>Knowledge Management → Add Remote Workspace</strong>, paste the link (or fill in host, port, token). The shared directory is merged into the tree (☁️ icon, at the bottom) with lazy loading.'
        },
        step3: {
          title: 'Preview & Download',
          desc: 'Remote files are <strong>read-only previews</strong>: Markdown / text read directly; <strong>PDF / image / Word</strong> preview inline in the Browse view — PDF with page flip & zoom, image with zoom & drag, Word (.docx) auto-converted to Markdown. To edit, click "<strong>Download to Local</strong>" on the top bar to save into the current workspace.'
        },
        step4: {
          title: 'Refresh Remote Directory',
          desc: 'Each remote workspace root has a <strong>refresh button</strong> (🔄) on its far right; click to re-fetch the server directory and see files added / modified / deleted on the host. Right-click a remote node for "Preview / Download to Local Workspace / Remove Remote Workspace".'
        },
        note: {
          title: '📌 Tip:',
          text: 'Remote files are <strong>read-only</strong>; download to the local workspace before editing. Removing a remote workspace never affects host files. The host must keep the shared service running and clients must be on the same LAN and able to reach port 3347.'
        }
      },
    },
    knowRAG: {
      overview: {
        title: 'What is Knowledge Processing?',
        description: 'Knowledge processing (knowRAG) turns your local documents into a <strong>searchable, learnable and testable knowledge base (RAG)</strong>, following the <strong>global AI configuration</strong> (Ollama / LM Studio / OpenAI / DeepSeek / Anthropic / Google / Azure, etc.). Eight top tabs organize the workflow: QA / Files / Slices / Questions / Encyclopedia / Ontology / Test / Settings — pick a library & convert, slice & embed, extract entities (Encyclopedia) & questions (Questions), run strategy-based Q&A and automated tests, then save a .kb for reuse (e.g., in Learning). Retrieval strategies are customizable in Strategy Config (ingestion + retrieval pipelines), with built-ins such as Similarity / File Enhance / Question Enhance / Ontology Enhance / Multi-hop / Community / Agentic.'
      },
      workflow: {
        title: 'Processing Flow',
        step1: 'Files: pick / convert',
        step2: 'Slices: chunk / embed',
        step3: 'Encyclopedia+Questions: extract entities / questions',
        step4: 'QA: strategy retrieval & answer',
        step5: 'Test: evaluate / save .kb'
      },
      views: {
        title: 'Feature Views',
        file: { title: '📁 File View', desc: 'Open a folder as the knowledge base root. Supported files (PDF, Word, Markdown) are listed on the left; click to preview content on the right. The top status bar shows PDF/Word normalization (convert to same-named .md in one click) and file-change stats; when incremental detection finds added / modified / deleted files, the affected filenames are colored with badges. The left column also lists <strong>missing files</strong> (recorded by the KB but absent from the folder; matched by filename so folder renames/moves are tolerated) — the 🗑 icon cleans up their slices / questions / summaries (asks for confirmation; saving never deletes them automatically).' },
        slice: { title: '✂️ Slice View', desc: 'Choose chunking strategy (Default/Smart/Semantic), click the split button to divide documents into fragments, then click embed to generate vectors. "Incremental Update" detects added / modified / deleted files, re-slices changed files, and syncs summaries, ontology, communities and reports (reusing unchanged slice vectors idempotently). Question extraction lives in the Questions tab.' },
        ontology: { title: '🕸️ Ontology View', desc: 'D3.js force-directed graph of entities / relations / slices / files / questions; click a node to highlight and inspect details & related chunks. <strong>Manual Link</strong> (⛓): enter link mode and click two <strong>concept nodes</strong> in turn — the LLM decides the relation type (concepts only; prompts and results show in the bottom status bar). Building / clearing the ontology now lives in the Encyclopedia tab. Community <strong>report generation</strong> supports pause / resume / stop: the button turns into ⏸ while running, ⏵ resumes from the checkpoint (already-generated reports are not recomputed), and progress shows in the bottom status bar.' },
        card: { title: '🧊 Encyclopedia View', desc: 'Manage entities (= encyclopedia entries) in a card grid. It is the <strong>ontology build entry</strong>: ▶ Start extract (entities/relations/descriptions; progress shows in the bottom status bar), ↻ Continue (from checkpoint when one exists), 🗑 Clear (removes all entities i.e. cards and their relations, asks for confirmation). Supports search, manual entity add, batch description inference; click a card for details / description editing / associated chunks.' },
        qa: { title: '💬 Q&A System', desc: 'The chat panel lets you pick a <strong>retrieval strategy</strong> from the top dropdown (built-ins include Similarity / File Enhance / Question Enhance / Ontology Enhance / Multi-hop / Community / Agentic, configurable in Strategy Config) and shows the evidence chunks behind each answer. Adjustable match threshold, retrieval count, cosine/BM25 hybrid weights. If the KB is not sliced / vectorized yet, asking a question will automatically prepare it and then retrieve.' },
        question: { title: '❓ Questions Tab', desc: 'Question-bank hub: ▶ extract "question + answer" pairs from slices (pause / resume / stop; progress in the bottom status bar; by default it <strong>reasons first and runs one unified embedding pass afterwards</strong> to avoid LM Studio repeatedly swapping the chat/embedding models — click ⚡ to embed right after each call instead); manual add, semantic dedup / LLM merge, Excel import-export, compound questions. ⚖ Independence review lets the LLM flag questions that cannot be answered independently (session-only; the unsuitable count shows in the bottom status bar). 🗑 Clear all questions (asks for confirmation; slices & files are untouched, and test cases derived from the bank are cleared too). The list lazy-loads 40 per scroll.' },
        test: { title: '🧪 Test Tab', desc: 'Automated evaluation: test questions & reference answers auto-sync from the Questions tab. 🔄 Read Test Cases re-derives questions from the question bank after you change the max limit in settings. Supports batch testing (current / all strategies — both can be <strong>paused / resumed / stopped</strong> while running, keeping tested results), rank analysis, and Excel export. The toolbar also lets you pick an <strong>evaluation embedding model</strong> from the current AI source (no need to open Settings; "Follow settings" uses the Settings embed model, and the choice is saved with the .kb without changing the setting value). If slices have no vectors (e.g. a KB saved in slim mode), vectors are filled in before the test runs so scores are not all 0. The toolbar\'s 🔥 button opens a <strong>"Pre-warm / Vector caches" popup</strong>: one table lists "generate summaries" plus summary / slice / question / entity vector caching (and community reports) with tick / status / progress / time in the same row (no duplicates). Existing summaries (including the 摘要 metadata in md frontmatter) or vectors are skipped instead of regenerated, and ready items are shown in the theme color. A toolbar number box sets a <strong>repeat count</strong> (all-strategy test only): the same question set is run N times and metrics are shown as <strong>mean ± std</strong>. The comparison table also shows <strong>cost columns</strong> (LLM calls / question, tool calls / question — hover for the tool mix) and a <strong>paired significance test</strong> (pick a baseline to get McNemar p for hit differences and Wilcoxon p for rank differences, plus a verdict); everything is exported to Excel. Besides Slice hit / Answer hit, the hit rule can be <strong>"LLM Judge"</strong> (agentic strategies only): the chat model compares the retrieved snippets with the question and reference answer and returns <strong>hit + best matching rank</strong> (paraphrases or spread-out answers still count); judge calls count toward the "LLM calls / question" cost but not toward retrieval time, and the verdict plus reason are visible in the trace. For agentic strategies, click <strong>"Trace"</strong> in a result row to review that run\'s tool-call timeline (round / tool / args / output). Tick <strong>"Save Test Results into KB File"</strong> under Settings → Processing to persist all of this in the .kb, so reloading shows and exports it without re-running.' },
        settings: { title: '⚙️ Settings Tab', desc: 'Three groups: KB config (.kb management), Strategy Config (custom retrieval strategies, below), and Processing Config (slice strategy, question dedup, test-case limit, ontology prompts & batch size, whether vectors / test results are written into the KB file, etc.). Models follow the global AI configuration.' }
      },
      qaModes: {
        title: 'Q&A Modes & Built-in Strategies',
        similarity: { name: 'Similarity', desc: 'Pure slice-vector cosine retrieval. Fast, ideal for precise single-point queries.' },
        fileEnhance: { name: 'File Enhance', desc: 'File-level retrieval: a plain slice baseline, then weighted by the file semantic summary score. Great for file-level / cross-document topics.' },
        questionEnhance: { name: 'Question Enhance', desc: 'Uses question-bank vectors as the boost channel (0.7 question + 0.3 slice; max similarity over the linked questions of a slice). Good for answering around "answerable knowledge points".' },
        ontology: { name: 'Ontology Enhance', desc: 'Resolves entities in the query via fuzzy match or LLM, then multiplicatively boosts the slices they hit. Great for entity-relationship questions.' },
        multiHop: { name: 'Multi-hop Search', desc: 'Starts from matched entities and expands along the knowledge graph via BFS (up to 2 hops), aggregating indirect relations. Great for multi-hop reasoning, with reasoning-path evidence shown.' },
        multiStage: { name: 'Community Search', desc: 'GraphRAG-style Map-Reduce: first run community detection to generate community reports, then summarize slices in parallel and merge into a global answer. Great for "big picture" questions.' },
        agentic: { name: 'Agentic Search', desc: 'LLM-driven multi-round retrieval: the model decides search terms and repeatedly calls kb_search until enough evidence is gathered (deduplicated). Great for complex open-ended questions.' },
        note: {
          title: '📌 Tip:',
          text: 'Similarity and File Enhance need no ontology; Ontology Enhance and Multi-hop need the ontology built; Community also needs community detection; Question Enhance uses question-bank vectors as the boost channel (its ingestion pipeline auto-fills question vectors). If the KB is not sliced / vectorized, asking will automatically build and retrieve. The right "Evidence" panel shows retrieved chunks or reasoning paths for each strategy. These are only the default built-in strategies — define custom ones in KB → Settings → Strategy Config (ingestion / retrieval pipelines; the retrieval pipeline has a "Question Channel" toggle), and the QA dropdown lists all enabled strategies.'
        }
      },
      config: {
        title: 'Configuration',
        description: 'Knowledge processing uses the models from the <strong>global AI configuration</strong> (Settings → General → LLM); no separate source selection is needed here. Embedding, chat, and processing models default to the source\'s default embed model and main model; the embed model can be adjusted in the KB "Settings". Supports cosine similarity, BM25, and hybrid retrieval; retrieval count can be By Quantity / By Match Ratio / By Characters; retrieval strategies can be customized in "Strategy Config" (below).'
      },
      strategies: {
        title: 'Custom Retrieval Strategy (Pipeline)',
        intro: 'QA and tests are no longer limited to fixed modes. In KB → Settings → <strong>Strategy Config</strong>, you can define custom retrieval strategies: choose the strategy kind, compose "ingestion pipeline" and "retrieval pipeline" primitives, tune parameters; the QA dropdown and automated tests run with the selected strategy.',
        kinds: {
          title: 'Four Strategy Kinds',
          pipeline: { name: 'Pipeline', desc: 'Most flexible: compose "ingestion pipeline" (build time) and "retrieval pipeline" (query time) primitives yourself; each step has a primitive, a mode (Set base score / Multiply boost / Weighted fuse / Max) and parameters.' },
          mapreduce: { name: 'Community (Global)', desc: 'GraphRAG-style Map-Reduce: generate community reports first, then summarize slices in parallel and merge into a global answer. Great for "big picture" questions.' },
          agentic: { name: 'Agentic Routing', desc: 'LLM-driven multi-round retrieval: toggle kb_search / file_search / entity_link / entity_slice / graph_hop / community_search tools; the model decides the retrieval path. The <strong>system prompt is customizable</strong> (empty = built-in default, chosen by locale), tools without data are hidden, and the final ranking is deterministic (slice-level evidence first, tool channel score blended with original-question alignment) rather than produced by the model.' },
          hybrid: { name: 'Hybrid', desc: 'Enable multiple deterministic recall channels (dense / sparse / ontology / graph / community) at once, then unify ranking (cosine rerank or RRF fusion) and take TopK.' }
        },
        pipeline: {
          title: 'Ingestion Pipeline vs Retrieval Pipeline',
          ingest: '<strong>Ingestion pipeline (construction, build time)</strong>: runs during slicing / embedding / incremental updates to build the KB\'s enhanced capabilities — producing semantic vectors, ontology, communities, and reports for the query stage; already-processed data is skipped (idempotent). Five kinds of ingestion primitives: <strong>Question Semantic Enhance</strong> (backfill missing question vectors in the question bank; dependency pipeline of the Question strategy), <strong>File Semantic Enhance</strong> (file → summary vector), <strong>Extract Entities</strong> (slice → entities/relations), <strong>Build Communities</strong> (entity graph → communities), <strong>Generate Reports</strong> (community → report).',
          retrieve: '<strong>Retrieval pipeline (query time)</strong>: the primitive chain executed in order on each query, e.g., "dense recall → BM25 → entity link → graph hop → community filter → weighted fuse", deciding how knowledge is recalled and scored; missing required ingestion primitives are prompted for one-click completion.'
        },
        params: {
          title: 'Retrieval Parameters',
          desc: 'Each strategy can independently configure TopK, retrieval mode (By Quantity / By Match Ratio / By Characters), match ratio threshold, character limit, BM25 toggle and weight; QA and tests use the currently selected strategy\'s parameters, with enable / disable / restore-default support. Agentic adds four extra knobs: <strong>Max Rounds</strong> (tool-loop cap), <strong>Tool Candidate Pool</strong> (candidates each tool fetches internally; all join the evidence pool for the final ranking to raise the recall ceiling; empty = follow Processing Config), <strong>Rerank Blend</strong> (fuses the tool channel score with original-question content similarity; empty = follow Processing Config), and the <strong>Warm Start</strong> / <strong>Auto Fallback</strong> switches (turn the latter off for a pure LLM-routing ablation). Note that TopK is what gets shown / used as the evaluation K — it does not cap the tool candidate pool.'
        }
      }
    },
    workflow: {
      usage: {
        title: '📂 Open & save (.flow.yml in Knowledge Management)',
        items: [
          'Where: workflows are <strong>a file type in Knowledge Management</strong> — open a <code>.flow.yml</code> / <code>.flow.yaml</code> file to get the canvas; create one with the Workflow type',
          'Format: the file content is a <strong>Dify app DSL (YAML)</strong> document that Dify can import directly; opening a Dify export keeps unknown node types untouched and reports them',
          'Canvas: drag nodes, drag from the right-side port to connect, right-click the pane or a node to add one, <code>Ctrl+D</code> to duplicate, <code>Del</code> to delete; connections reject self / duplicate / cyclic links',
          'Bottom status bar: Add node / Auto layout / Run / App settings / <strong>AI authoring</strong> / Delete selected / Save on the left; node · edge count / zoom out / zoom % / zoom in / fit view / <strong>lock canvas</strong> / <strong>minimap toggle</strong> on the right, <code>Ctrl+S</code> saves',
          'AI authoring: click the ✨ button to open the panel, describe the change in plain language (e.g. “add an if-else”) and the model rewrites the whole workflow for you — undoable in one click; the panel looks exactly like the run panel',
          'Containers (iteration / loop): drop a node inside the box to make it a child; drag the bottom-right handle to resize the container (auto layout never shrinks it back); inner edges and the container’s own output edge are shown correctly',
          'Look: the canvas follows the theme in Settings → Interface (dark / light and every skin); each node card shows its key config on the second line (model, input / output variables, iterator variable, file …)',
          'The right panel appears on demand: select a node for the <strong>properties panel</strong>, click Run for the <strong>run panel</strong> (close it with ✕ at its top-right); they never show at the same time',
          'Save: the Save button writes the file; edits in the properties panel mark the file dirty immediately (a ● appears in the toolbar)'
        ]
      },
      nodes: {
        title: 'Node types',
        start: { name: 'Start', desc: 'Entry point; defines input variables' },
        end: { name: 'End', desc: 'Declares the final output variables' },
        answer: { name: 'Answer', desc: 'Uses the text as the reply' },
        llm: { name: 'LLM', desc: 'Calls a model with prompt and context' },
        agent: { name: 'Agent', desc: 'Runs the selected agent preset autonomously (planning + tool calls + skills / knowledge / MCP); outputs text / files / json' },
        ifElse: { name: 'If/Else', desc: 'Routes by conditions; falls through to ELSE' },
        classifier: { name: 'Question Classifier', desc: 'Lets the model pick a class branch' },
        iteration: { name: 'Iteration', desc: 'Processes each array item in the container, collecting results' },
        loop: { name: 'Loop', desc: 'Repeats container nodes, optionally with break conditions' },
        code: { name: 'Code', desc: 'Runs Python 3 with injected variables; a main() function is called automatically (Dify style), otherwise printed JSON keys become outputs' },
        template: { name: 'Template', desc: 'Fills a template with variables' },
        http: { name: 'HTTP Request', desc: 'Calls外部 HTTP APIs with variable templates' },
        tool: { name: 'Tool', desc: 'Calls external tools through MCP' },
        knowledge: { name: 'Knowledge Retrieval', desc: 'Retrieves relevant chunks' },
        aggregator: { name: 'Variable Aggregator', desc: 'Takes the first non-empty variable' },
        assigner: { name: 'Variable Assigner', desc: 'Writes conversation or loop variables' },
        listOp: { name: 'List Operator', desc: 'Filter / sort / extract / limit' },
        paramExtract: { name: 'Parameter Extractor', desc: 'Extracts structured parameters with a model' },
        extractor: { name: 'Document Extractor', desc: 'Reads a file into text' },
        word: { name: 'Export Word', desc: 'Exports upstream content as .docx (local extension)' },
        csv: { name: 'Local Table', desc: 'Reads CSV / TSV / Excel, optionally batched (local extension)' },
        localFile: { name: 'Local File', desc: 'Reads a file with optional template slices (local extension)' },
        localKb: { name: 'Local Knowledge', desc: 'Retrieves from a local .kb file (local extension)' },
        mcp: { name: 'MCP Tool', desc: 'Inline or configured MCP service (local extension)' },
        subflow: { name: 'Sub-workflow', desc: 'Runs another workflow file (local extension)' }
      },
      variables: {
        title: '🔗 Variables, branches and containers',
        items: [
          'Every value is picked with the <strong>variable selector</strong> (no hard-coded node names): grouped as upstream node outputs / system / environment / conversation variables, so renaming a node never breaks links',
          'Inside text (prompts, answers) reference variables as <code>{{#node.var#}}</code>; the selector\'s “Insert variable” writes it at the caret',
          '<strong>Branch nodes</strong> (If/Else, Question Classifier) expose one port per branch; at runtime only the matched branch runs and the others are marked “Skipped”',
          '<strong>Container nodes</strong> (Iteration, Loop): drag a node inside the container box to make it a child; the entry node exposes <code>item</code> and <code>index</code>, and loops can update variables with the Variable Assigner'
        ]
      },
      run: {
        title: '▶️ Running and settings',
        items: [
          'Run: toolbar “Run” → fill the input variables declared by the Start node → Start run; you can stop at any time',
          'Canvas feedback: the dot on each node shows its state (blue = running, green = success, red = failed, grey = skipped); the run panel offers a <strong>trace tree</strong> (container children indented), per-node duration, logs and streamed output',
          'Run history: switch between the last 5 runs at the top of the panel to compare results',
          'Debugging: with a node selected you can “Test this node” or “Run this node and downstream” without re-running upstream; the run panel’s <strong>Variables</strong> section lists every node output, and you can edit a value and re-run just that node (edited values are marked and can be reverted one by one or all at once)',
          'App settings: the toolbar “App settings” edits the app name / icon / mode, opening statement and suggested questions, feature toggles, and the global <strong>environment</strong> and <strong>conversation</strong> variables',
          'Error handling: each node can terminate, continue on error, remove abnormal output or take a fail branch; LLM / Agent / HTTP Request / Code / Tool nodes can also continue with a <strong>default value</strong> (a JSON object keyed by output variable), and retries with exponential backoff are available'
        ]
      },
      example: {
        title: 'Example: from a question to a Word report',
        step1: {
          title: 'Add four nodes:',
          tags: ['▶️ Start', '🤖 LLM', '🔀 If/Else', '📄 Export Word']
        },
        step2: {
          title: 'Connect and bind variables:',
          description: 'Drag from a node\'s right port to the next node; pick upstream outputs with the variable selector in End or Export Word',
          flow: 'Start(question) → LLM → If/Else → Export Word'
        },
        step3: {
          title: 'Configure and run:',
          items: [
            'Start: define the input variable question',
            'LLM: pick provider and model, then insert {{#Start.question#}} in the prompt',
            'If/Else: give the branches conditions (e.g. length > 100)',
            'Export Word: bind the content variable to the LLM text, choose template and folder',
            'Click Run in the toolbar, fill question, and watch per-node duration and output in the run panel'
          ]
        }
      }
    },
    settings: {
      overview: {
        title: 'Settings Overview',
        description: 'All application configuration lives in the <strong>Settings</strong> panel with a two-level left nav: <strong>General</strong> (Basic / LLM / Credentials / Associations / Other), <strong>Collaboration</strong> (Sharing / Collaborative Editing / Permissions), <strong>Speech</strong> (TTS / ASR), <strong>Tools</strong> (Tools / Search / MCP / Registry), <strong>Plugins</strong> (Manage / Store / Develop), <strong>Skills</strong> (Manage / Store), <strong>Agent</strong> (Presets / Console / Session Log), and <strong>Help</strong>. Click an item on the left to open that panel; global settings (e.g. LLM) apply to Home, Knowledge Processing, Speech, etc.<br>In a tall window (aspect ratio above 16:9, e.g. a phone in portrait) the nav and the content each fill the screen and switch in place (the category list uses piano-key rows; ← returns to the categories). List-style panels inside Settings — model sources, search sources, MCP, plugin management, skill management / store, and the agent presets / console / session log — behave the same way: a full-screen list and a full-screen detail pane. Skill Management and the Skill Store drill down one screen at a time (skills → file tree → file editor; store: skill grid ⇄ source list ⇄ skill detail), with ← on each screen to go back one level.'
      },
      groups: {
        basic: {
          title: '🧭 General',
          items: {
            view: { name: 'Basic', desc: 'Language / theme / window zoom / <strong>text alignment</strong> (browser justify vs Knuth\u2013Plass optimal) / <strong>close button behavior</strong> / <strong>portable config</strong>, plus paths and common actions.' },
            features: { name: 'Features', desc: 'Switches for the main navbar entries (top-level modules: Home / Knowledge / Knowledge Processing / Learning, plus the <strong>Browser Agent</strong> globe icon — hiding it removes the icon from the navbar, while the AI and the Knowledge Management panel can still open the browser) and the <strong>view</strong> shown on the right of Knowledge Management (Files / Kanban / Table / Graph / Map / Year Calendar — single choice, one view at a time; previewing a remote file switches to Browse automatically).' },
            data: { name: 'Data', desc: 'Local data overview: local storage usage, the data folder (openable) and cleanable cache; <strong>Config Backup</strong> exports / imports all config in one click. The inventory lists counts & sizes for chats / legacy todos & notes / agent presets / MCP / session logs / config — each row can be exported / imported (session logs can be cleared or opened in the file manager) and jumps to the related settings page. Only local data is counted; workspace files such as knowledge bases, workflows and Data Canvas are not included (check Knowledge Management for those).' },
            fileassoc: { name: 'Associations', desc: 'Set the system default app per file type; one-click set all / clear all.' },
            other: { name: 'Other', desc: 'System status (Python check and <strong>Security Policy</strong>: read-only / workspace-write / full-access, which decides whether the agent may run code, shell commands and network calls — applied to every window immediately and kept after restart), browser settings, Word export and offline maps (MBTiles).' }
          }
        },
        models: {
          title: '🧠 Models',
          items: {
            llm: { name: 'Sources', desc: 'Per-source connection settings (URL / key / model / API style / default embedding model), <strong>common parameters</strong> (temperature / max tokens / streaming / reasoning effort) and the <strong>context window</strong> (detailed below). Clicking a source only views it — press <strong>Set as default</strong> to change the default.' },
            'llm-embed': { name: 'Embedding', desc: '<strong>Embedding fallback</strong>: when the current source has no embedding endpoint (e.g. DeepSeek / Anthropic), KB building and retrieval embedding uses the source chosen here.' },
            credentials: { name: 'Credentials', desc: 'API keys managed as a table; plaintext stays in the main process and can be referenced by each source.' }
          }
        },
        collabGroup: {
          title: '🤝 Collaboration',
          items: {
            share: { name: 'Sharing', desc: 'LAN sharing (remote web entry / port / KB folder) and shared folder (read-only file service: port / directory / token).' },
            collab: { name: 'Collaborative Editing', desc: 'Collaborative editing: port / max members / edit permission (open \u00b7 approve \u00b7 read-only) / room token.' },
            perm: { name: 'Permissions', desc: '<strong>LAN guest whitelist</strong>: allowed chat modes, agent tools (read-only by default), concurrency and steps, <strong>file access</strong> (off by default; read-only lets guests browse / preview / search the shared folder set on the Sharing tab, read &amp; write also lets them create / save / delete inside it), sandbox level and access token.' }
          }
        },
        speech: {
          title: '🗣️ Speech',
          items: {
            tts: { name: 'TTS', desc: 'Speech synthesis: voice / speed / engine (incl. local Kokoro / Piper).' },
            asr: { name: 'ASR', desc: 'Speech recognition: local ONNX Whisper or a server engine (Whisper API / Qwen3-ASR web UI), auto punctuation.' }
          }
        },
        tools: {
          title: '🧰 Tools',
          items: {
            tools: { name: 'Tools', desc: 'Per-tool switches: enablement, sandbox preference and approval (18 tools).' },
            search: { name: 'Search', desc: 'Web search source: Bing / Baidu / DuckDuckGo / SearXNG / Bocha / Zhipu / Tavily / Brave — enable several, add custom LAN sources, and pick fallback / merge strategy.' },
            mcp: { name: 'MCP', desc: 'Manage MCP servers; <strong>6 built-in servers</strong> are pre-installed (detailed below).' },
            toolregistry: { name: 'Registry', desc: 'Read-only view of the registered tools and their whitelist state.' }
          }
        },
        plugin: {
          title: '🔌 Plugins',
          items: {
            plugin: { name: 'Manage', desc: 'Discovery, enable / disable, reload, logs, config, details and removal for local plugins — every row action is an icon button (hover for the hint); the <strong>search box</strong> under the title filters the list by name / plugin id / folder / permission / tool / service / description / status (the counter shows “matched / total”), and hovering the ⚠️ icon next to the title shows the <strong>security notice</strong>. A plugin can add agent tools <strong>and</strong> UI — a main panel (appears in the nav automatically), settings tabs, settings cards and swarm workbench tabs, plus global shortcuts and zh / en text. Two new host capabilities: <strong>model access</strong> (pick source and model, permission <code>llm</code>) and <strong>file access</strong> (pick files / folders, list directories, read text, <strong>read spreadsheets via <code>readSheet</code></strong> (.xlsx/.xls/.csv — the UI half has no SheetJS, so plugins read tables with it), <strong>read raw bytes</strong> via <code>readBase64</code>, extract PDF text and <strong>render PDF pages</strong>, permission <code>fs</code> — limited to paths you picked inside that plugin, for the current run only), plus read-only app info (agent preset list) and <strong>speech</strong> (hand text to the app’s own TTS; engine and voice follow Settings → Voice; no permission needed). Install a plugin package (a <code>package.json</code> plus an <code>aikm</code> manifest) from a folder, and optionally delete its files when removing it. The plugins folder defaults to <code>userData/plugins</code> but can be pointed at your own folder, like skills (changes reload automatically). <strong>Plugins may live in subfolders</strong>: put them directly in the plugins folder or group them by purpose in nested folders (up to 4 levels deep are scanned; a plugin’s own <code>node_modules</code> / hidden folders are never mistaken for plugins), and every row shows which folder it belongs to. <strong>Newly written plugins are discovered automatically</strong> (loaded and shown in the UI within about a second — no restart, no manual scan); the folder bar’s <strong>Rescan</strong> (🔍+) stays as a fallback. Every plugin also has <strong>data</strong> management (🗄️): see how much it uses (settings in localStorage, large files such as saves in the local OPFS <code>plugins/&lt;plugin id&gt;/</code>, and plugin-private data in the main process <code>plugins-data/&lt;plugin id&gt;/</code>), list every entry and delete them one by one or all at once — the list shows the size when it is not zero. <strong>Reload also re-loads the plugin’s UI half</strong> (no restart needed after editing its client code); if the UI half fails to load, the row is flagged “UI half failed” with the reason and Reload retries it. Plugins run in the main process and are <strong>not confined by the workspace sandbox</strong>; the permissions they request are listed before enabling.' },
            'plugin-store': { name: 'Store', desc: 'Use a <strong>shared folder</strong> as a plugin source: paste the <code>remote-fs://ip:port?token=…</code> address shown under Collaboration → Share (or click “Local share”) to browse and one-click install the plugins inside. No new protocol involved — the share is already a read-only, token-guarded HTTP service, and the store index is scanned on the fly (drop plugin / skill folders into the shared folder, category subfolders included, no hand-written index needed). Installing always lists the requested permissions first; afterwards enable / reload / remove it under Manage. The same address also works as a skill-store source.' },
            'plugin-dev': { name: 'Develop', desc: 'Where you write plugins: copy the general development prompt to any model and drop the returned files into the plugins folder, or simply pick the <strong>“Plugin development agent”</strong> in chat — it is bound to the built-in MCP service <code>builtin-plugin-dev</code> (6 short tools: <code>plugin_dev_host</code> / <code>plugin_dev_constraints</code> / <code>plugin_dev_manifest</code> / <code>plugin_dev_api</code> / <code>plugin_dev_faq</code> / <code>plugin_dev_templates</code>), which fetches this same official reference (constraints, manifest fields, slots, host API, minimal example) plus your plugins-folder path in small on-demand pieces, with no manual pasting and no hunting for the app’s source on disk. <strong>The folder-naming rule is stated up front</strong> in the dev prompt, the templates, the hard constraints and this MCP service: the folder name must equal the manifest’s <code>aikm.id</code> and be ASCII lowercase <code>[a-z0-9._-]</code>; a folder named in Chinese, with uppercase letters or spaces is skipped entirely (it will not appear in the list — the manager says so), so put Chinese in <code>aikm.name</code> and the UI copy. Also includes UI-plugin / settings-tab-and-card / chart / tool / model-and-file templates (the settings section lists the valid settings-group and settings-page ids — a wrong group id adds a second top-level “Plugins” menu), a debugging prompt (paste the error from Plugins → Manage → Logs so the model can fix it), a minimal runnable example, a manifest / slot / API cheat sheet, and the full “how to use plugins” walkthrough (install → confirm permissions on enable → where panels, tools and shortcuts appear → config → troubleshooting → removal).' }
          }
        },
        skills: {
          title: '🧩 Skills',
          items: {
            manage: { name: 'Manage', desc: 'Manage skill files: enable / disable, edit (trigger with $skill-name in chat).' },
            store: { name: 'Store', desc: 'Search, preview and install skills from remote sources such as GitHub.' }
          }
        },
        agent: {
          title: '🤖 Agent',
          items: {
            presets: { name: 'Presets', desc: 'Role / model / system prompt and per-tool capabilities; pick with 👤 in chat. Eight built-in presets ship with the app — General Agent, Code Agent, Office Agent, PTC Agent, Plugin Dev Agent, plus Pi Agent, DSH Agent and Codex Agent — ready to use and editable, but not deletable (the last three mirror open-source harnesses in prompt structure and tool orchestration: Pi is minimal with no plan mode or subagents, DSH composes persona and capability through <strong>sections</strong> with runtime guards, Codex spells out the read-only / workspace-write / full-access ladder). <strong>Breaking one is not fatal</strong>: every built-in preset has a “Reset” button at the right end of its tab bar — confirm and its name / model / prompt / tools / skills / MCP / loop sections return to the factory values (user presets do not show it). On the Tools tab you can also set the <strong>presentation</strong> to PTC (programmatic tool call): the model only sees <code>run_code</code> and composes the preset tools inside a program.' },
            console: { name: 'Console', desc: 'Watch live plans, task lists, tool-call timelines and background tasks.' },
            log: { name: 'Session Log', desc: 'Session event log (JSONL): event stream, message dispatch and integrity.' }
          }
        },
        helpg: {
          title: '❓ Help',
          items: {
            help: { name: 'Software Help', desc: 'This page: usage guides, quick start and the changelog.' }
          }
        }
      },
      contextUsage: {
        title: '🧮 Context Window & Usage Ring',
        overview: 'Every conversation has its own <strong>context window</strong> (the token budget the model can remember at once). The <strong>ring</strong> next to the chat title on Home shows the current usage: hover it to see “used / limit” and how the limit was determined. Below 70% it uses the theme colour, 70–90% turns orange and ≥90% turns red — a hint to start a new chat. At <strong>80%</strong> earlier turns are compacted automatically (see item 4).',
        step1: {
          title: 'How “used” tokens are measured',
          desc: 'The <strong>real promptTokens</strong> returned by the backend are used when available; otherwise usage is <strong>estimated</strong> with the same counting rules as the actual request and the tooltip says “(estimated)”. The estimate includes <strong>tool results (file contents read)</strong>, <strong>tool arguments (file contents written)</strong>, knowledge-base blocks, attached images and the <strong>fixed overhead</strong> (system prompt + tool schemas + seeded history), then applies a <strong>measured calibration factor</strong>: local models (Ollama / LM Studio) differ from the estimation rules by 15–30%, and the factor is remembered per provider + model. Swarm mode shows no ring (each member has its own context, so a merged number would be meaningless).'
        },
        step2: {
          title: 'Where the denominator comes from',
          desc: 'Priority: <strong>manual per-provider value &gt; real backend probe &gt; model-name keyword &gt; provider default &gt; 128K</strong>. Ollama / LM Studio actively probe the real window of the loaded instance (for example a local Ollama manually set to 64K is detected); providers that cannot be probed fall back to the model-name / provider default estimation.'
        },
        step3: {
          title: 'The two read-only rows under “LLM”',
          desc: 'In Settings → General → <strong>LLM</strong>, the <strong>Ollama and LM Studio</strong> blocks have a <strong>Loaded Models</strong> row: a grid listing every model with its type (chat / vision / embedding), loaded state, and an <strong>effective-context vs model-max</strong> comparison (Ollama also shows the Modelfile num_ctx), plus <strong>⬇ load / ⏏ unload</strong> buttons (Ollama via keep_alive, falling back to /api/embed for embedding models; LM Studio via the official lms CLI); it grows freely with no scrollbar, so these two sources no longer duplicate a “Context window” row. Other providers keep a read-only <strong>Context window</strong> row showing the denominator the ring actually uses; to re-probe, click <strong>API Status</strong> at the bottom of that block (per-row refresh buttons were merged into it). The <strong>Window override</strong> row appears only when you have a historical override set (then you can ✕ clear it).'
        },
        step4: {
          title: 'Automatic context compaction',
          desc: 'When usage reaches <strong>80%</strong> of the window, earlier turns are <strong>compacted automatically</strong>: they are replaced by a structured summary (the latest 3 turns stay verbatim), stored with the session and viewable under Settings → Logs. The model keeps the goal, decided facts, key paths and open issues, while older verbatim details give way to the summary — <strong>no original message is deleted from the chat</strong>. If the backend reports a context overflow, the request is compacted and <strong>retried once</strong>, which also avoids the silent prompt truncation (“amnesia”) of local Ollama / LM Studio backends. Compaction is <strong>visibly reported</strong>: in agent mode the conversation shows “<strong>Compacting context…</strong>” and the card then turns into “Earlier turns were summarized (originals are kept)” with a toast; normal chat toasts when it compacts before sending or retries after an overflow.'
        },
        note: {
          title: '📌 Tip:',
          text: 'The window limit is per “provider + model”, so switching models changes the denominator. If the ring looks wrong, click <strong>API Status</strong> at the bottom of that provider block to re-probe, or check whether your backend returns token usage at all (when it does not, the number is an estimate).'
        }
      },
      webSearchSources: {
        title: '🔎 Web Search Sources (web_search)',
        overview: 'Agents, batch runs and the workflow web-search node share the same <strong>web_search</strong> tool. By default it uses <strong>keyless Bing web search</strong>; in Settings → Tools → <strong>Search</strong> you can <strong>enable several sources at once</strong> (toggles in the left list) and pick a strategy: <strong>Fallback</strong> (try sources in list order until one returns results) or <strong>Merge</strong> (query all enabled sources and merge by URL). The <strong>+</strong> button adds <strong>custom (LAN) sources</strong>. Changes take effect immediately, no restart.',
        step1: {
          title: 'Keyless sources (ready to use)',
          desc: '<strong>Bing</strong> (default; long Chinese questions are rewritten into keywords), <strong>Baidu</strong> and <strong>DuckDuckGo</strong> need no configuration. The first two work on mainland networks; DuckDuckGo may be blocked on some networks.'
        },
        step2: {
          title: 'Self-hosted / API key sources',
          desc: '<strong>SearXNG</strong> needs your instance URL (with JSON output enabled); <strong>Bocha</strong>, <strong>Zhipu</strong>, <strong>Tavily</strong> and <strong>Brave</strong> need their API keys (Zhipu offers basic / advanced search). Keys are stored locally only.'
        },
        step3: {
          title: 'Custom (LAN) sources',
          desc: 'The <strong>+</strong> button adds any number of custom sources for <strong>intranet / LAN search</strong>: a <strong>SearXNG-compatible instance</strong> (just the URL, e.g. <code>192.168.1.10:8080</code>, with JSON output enabled) or an <strong>HTTP JSON API</strong> (internal wiki / search service: request URL with an optional <code>{query}</code> placeholder — GET appends <code>?q=</code> when omitted — plus API key (sent as Bearer) and custom headers (with <code>{key}</code>), and a mapping for the results array and title / URL / snippet fields). Custom sources reorder, toggle and test exactly like built-in ones and take part in Fallback / Merge; use “Delete” on the right to remove one — the ↺ reset clears them all.'
        },
        note: {
          title: '📌 Tip:',
          text: 'The list order <strong>is</strong> the attempt order — <strong>drag</strong> any source to reorder (it is the priority under Fallback). Each source can be <strong>tested individually</strong> (regardless of enable state), and “Test all enabled” runs <strong>every enabled source one by one</strong> and expands its results or failure reason. The ↺ button in the toolbar <strong>resets</strong> all search sources (clears keys, back to Bing only). <strong>Max results</strong> controls how many results each search returns (1–20). Doc and result links open in the <strong>built-in browser</strong> instead of the system browser. Page fetching (web_fetch) is unaffected by the search source.'
        }
      },
      builtinMcp: {
        title: '🧩 Built-in MCP Servers (Pre-installed)',
        overview: 'Under Settings → Tools → <strong>MCP</strong>, six <strong>in-process built-in servers</strong> are pre-created (auto-injected at startup / when opening the page, enabled & auto-connected by default, <strong>cannot be deleted</strong>): they need no external process, their tools can be called by the general agent / Agent presets / workflow MCP nodes, and each can be “externally exposed over HTTP” for other MCP clients (Claude Desktop, Cursor, etc.) via the “External HTTP” toggle on the left.',
        browser: {
          name: 'Built-in Browser Agent (builtin-browser)',
          desc: 'Provides an <strong>AI-controllable real browser window</strong> (multi-tab), exposing browser_* tools — browser_navigate / list_tabs / new_tab / switch_tab / close_tab / get_html / extract_text / extract_markdown / screenshot / click / type / scroll — so AI can research online, click & fill forms, and harvest page content; implemented by the main-process browser agent service (entry: see Browser Operation in the Knowledge chapter).'
        },
        office: {
          name: 'Office Documents (builtin-office, Word + Excel)',
          desc: 'Reads & writes local <strong>.docx</strong> and <strong>.xlsx</strong> files (34 tools, session-based: open returns a docId / workbookId). <strong>Word</strong>: open_document / list_blocks / read_text / <strong>find_text</strong> (locate) / <strong>document_info</strong> (word count · outline · style list) / export_markdown / find_and_replace_text / <strong>replace_paragraph</strong> (rewrite a block, style kept) / <strong>insert_paragraph</strong> / <strong>insert_table</strong> / <strong>insert_markdown</strong> / <strong>set_paragraph_style</strong> (heading level or style) / <strong>delete_block</strong> / save_document (auto <code>.bak</code> backup); <strong>styles</strong>: <strong>list_styles</strong> (style list · format · usage) / <strong>create_style</strong> (new paragraph or character style) / <strong>update_style</strong> (edit a style definition, referencing text follows) / <strong>delete_style</strong> / <strong>set_text_format</strong> (font, size, bold, color for matched text — no style needed). <strong>Excel</strong>: open_workbook / list_sheets / read_sheet (range as Markdown/JSON/CSV, formulas optional) / search_cells / <strong>query_rows</strong> (multi-condition filter · sort · paging, returns a compact table) / <strong>aggregate</strong> (<strong>one-call statistics</strong>: <strong>multi-column grouping</strong> with per-group <strong>row count &amp; share</strong> for frequency, plus sum / avg / count / distinct / min / max; <code>sortBy:"行数" + limit</code> returns the most frequent value) / set_cells (batch write, existing styles kept) / append_rows / add_sheet / rename_sheet / delete_sheet / create_workbook / save_workbook / close_workbook. Writes only touch the affected XML parts (body text only document.xml, style edits only styles.xml; formulas, charts and images are preserved) and always back up to <code>.bak</code> first; .xls / .csv are read-only (writing tells the model to save as .xlsx first). Tool arguments are alias-normalized (e.g. query_sheet → sheet, workbook_id → workbookId), and missing required arguments such as workbookId / docId are reported up front with an “open first” hint instead of a vague “session closed” error. Excel read / statistics tools also accept a plain <strong>path</strong> (an existing session is reused, otherwise the file opens automatically), and statistics results default to a <strong>compact table with a per-call output budget</strong> (tune with maxChars), so a small context window (e.g. 32k) is no longer filled up by one or two results.'
        },
        drawio: {
          name: 'drawio Diagrams (builtin-drawio)',
          desc: 'Reads & writes local <strong>.drawio</strong> files with 44 tools that edit XML directly in the main process (no editor needed): <strong>document / pages</strong> (create / read_document / list_pages / get_page / set_page / add_page / rename_page / delete_page), <strong>inspect & validate</strong> (list_cells / get_cell / search_cells / outline / stats / validate), <strong>create & edit</strong> (add_node / add_nodes / add_edge / connect / update_cell / move_cell / resize_cell / set_style / set_label / delete_cell / duplicate_cell / set_z_order / apply_fragment / set_parent), <strong>containers · layers · tags · metadata</strong> (add_container / add_layer / set_tags / set_metadata), <strong>layout</strong> (auto_layout / grid_layout / align / distribute / fit_page / translate_all), <strong>convert</strong> (import_mermaid / export_mermaid / import_csv / export_svg) and <strong>lookup</strong> (search_shapes / style_help) — so AI can draw, edit, lay out and export diagrams itself.'
        },
        literature: {
          name: 'Literature Search (builtin-literature)',
          desc: 'Aggregates five <strong>key-free</strong> open literature sources in 9 tools: <strong>search_crossref</strong> (CrossRef search with bibliographic / title / author fields, year, type and sort filters; a DOI query auto-routes to an exact lookup; <strong>update_type</strong> reaches retraction notices with the retracted original DOI and Retraction Watch ID), <strong>search_openalex</strong> (citations, open-access status & full-text links, abstracts; <strong>retracted_only</strong> and <strong>author_id</strong> filters), <strong>search_arxiv</strong> (arXiv preprints with ti: / au: / cat: query syntax), <strong>search_pubmed</strong> (biomedical literature incl. retracted publication[pt]), <strong>search_europepmc</strong> (Europe PMC: OA full-text links plus Retraction in/of relations, with OA-only and retracted-only filters), <strong>search_authors</strong> (OpenAlex author search: institution, works, citations, h-index, ORCID), <strong>get_by_doi</strong> (merged full metadata by DOI), <strong>get_retraction_info</strong> (three-source retraction status and notice records by DOI) and <strong>get_fulltext</strong> (open-access full text by DOI / PMID / PMCID). Lets agents search literature, verify citations, find free full texts and audit retractions — all through official APIs, never hitting web human-verification walls.'
        },
        postgres: {
          name: 'PostgreSQL Query (builtin-postgres)',
          desc: 'Lets AI query a local / intranet PostgreSQL database <strong>read-only</strong> — the typical case being an imported <strong>OpenAlex offline snapshot</strong> or other large dataset. Seven tools: <strong>pg_resolve_author</strong> (<strong>author disambiguation</strong>: a name — even just a surname or “surname + initial” — plus an optional institution reference returns ranked candidates with institution history, representative works and a confidence tier, or “No Result”; institution names missing from the DB or given as acronyms automatically fall back to keyword matching), <strong>pg_status</strong> (connection &amp; config self-check; call it first when troubleshooting), <strong>pg_list_schemas</strong>, <strong>pg_list_tables</strong> (tables/views with estimated rows and comments, keyword filter), <strong>pg_describe_table</strong> (columns / types / indexes / size), <strong>pg_sample_rows</strong> (sample to see data shape) and <strong>pg_query</strong> (read-only SQL: aggregates, CTEs, joins, window functions; returns a Markdown table). <strong>Three read-only guards</strong>: static SQL validation (only SELECT/WITH/TABLE/VALUES/SHOW/EXPLAIN; multi-statement and write keywords rejected), an enforced <code>default_transaction_read_only=on</code> session, and a statement timeout (30 s by default, raise via <code>PG_MCP_STATEMENT_TIMEOUT_MS</code>), with LIMIT auto-appended; after connecting, the single user schema (e.g. openalex) is set as search_path so plain table names work. Connection details go in “Configuration → Env vars (JSON)” (<code>PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD</code> or a single connection string); the password stays in local settings and is never sent to the model provider. A read-only DB role (GRANT SELECT) is recommended.'
        },
        pluginDev: {
          name: 'Plugin Development Reference (builtin-plugin-dev)',
          desc: 'Serves the official <strong>plugin development guide</strong> as an MCP service, split into <strong>6 short tools</strong> by topic (each returns only a few hundred to ~3,000 characters, so even small models can digest it): <strong>plugin_dev_host</strong> (absolute path of your plugins folder / installed plugins / where data goes), <strong>plugin_dev_constraints</strong> (the 15 hard constraints, including “call only the host APIs listed in the guide — the two halves are not interchangeable”, the async-ness and return shapes of ctx.files, and “canvas 2D does not resolve CSS variables”), <strong>plugin_dev_manifest</strong> (<code>package.json</code> manifest fields + built-in slots + a copy-paste manifest), <strong>plugin_dev_api</strong> (host API cheat sheet with async/return shapes + the full minimal runnable example), <strong>plugin_dev_faq</strong> (error → cause → fix), <strong>plugin_dev_templates</strong> (template index plus install steps; fetch one body with <code>key</code>, e.g. <code>{"key":"panel"}</code>) — plus <strong>plugin_dev_check</strong>, which self-checks a plugin folder with the host’s <strong>own</strong> validation logic (manifest / entry files / <strong>whether it calls ctx members the host does not have</strong> — ctx.service, ctx.files.readFile … are each reported with the correct alternative, and mixing the two halves is flagged too — plus silent failure traps such as a missing await, misusing the pickFiles return shape, an undisconnected ResizeObserver and using a <code>ctx.locale</code> ref as a string (which renders <code>[object Object]</code>)) and returns the <strong>host’s real load status and logs</strong>, including why the UI half failed to load. Content is shared with Settings → Plugins → Develop. The <strong>plugin development agent</strong> is bound to this server by default (called through mcp_call); other agents, workflow MCP nodes and external MCP clients (<code>/mcp/builtin-plugin-dev</code>) can use it too, so nobody has to hunt for the app’s source on disk.'
        },
        note: {
          title: '📌 Tip:',
          text: 'The delete button is unavailable for built-in servers (so browser / Word capabilities are never lost after accidental deletion), but you can still <strong>disable the enabled toggle, edit the name, test the connection, and view tools</strong>. If removed from the list, they are re-injected automatically on restart or when you open this settings page again.'
        }
      },
      closeBehavior: {
        title: '🚪 Close Button Behavior & Tray',
        overview: 'Settings → General → <strong>Basic</strong> → “<strong>Close Button</strong>” decides what happens when you click the window close button: <strong>Quit directly</strong> (default) or <strong>Collapse to tray</strong> (hide the window but keep running).',
        quit: {
          title: 'Quit directly (default)',
          desc: 'Closing quits the app. If background tasks are still running (batch agents / collection / agent sessions / workflows / swarm), a warning appears first and the close is blocked once — click again <strong>within 6 seconds</strong> to quit anyway, so a mis-click never kills your tasks.'
        },
        tray: {
          title: 'Collapse to tray (keep running)',
          desc: 'Closing only <strong>hides</strong> the window into the notification area (Windows) or menu bar (macOS); the app and its background tasks <strong>keep running</strong>. Because nothing is interrupted, no warning is shown and a balloon hint appears the first time. A <strong>file window</strong> (canvas / scaffold and other standalone windows) also only collapses while its <strong>background task is running</strong>, so the task is not killed — restore it from the tray; with no task running, closing works as usual.'
        },
        trayMenu: {
          title: '📌 What the tray icon offers:',
          hover: '<strong>Hover</strong>: the number of running tasks and each task’s progress (e.g. “AI-KM · 3 tasks running / · Agent Scaffold 12/50 · 3m20s left / · Agent Scaffold 3/80 · 9m10s left”).',
          leftClick: '<strong>Left click</strong>: hide the window when it is in front, bring it back when hidden; <strong>double click</strong> always brings it back.',
          rightClick: '<strong>Right-click menu</strong> (native system menu): Show Main Window / <strong>Settings…</strong> (opens Basic, where this option lives) / running task list (grouped by window when several windows have tasks — <strong>click a task to bring its window back</strong>) / hidden windows (collapsed windows, click to restore) / Quit AI-KM.'
        },
        note: {
          title: '📌 Tip:',
          text: 'To quit completely, use “Quit AI-KM” in the tray menu (or switch back to “Quit directly” and close the window). “Settings…” opens the settings window on the Basic page.'
        }
      }
    },
    dataCanvas: {
      usage: {
        title: '📂 How to use it (.data canvas file)',
        items: [
          'File type: <code>.data</code> is the canvas file — open it from the <strong>Knowledge Management</strong> file tree: <strong>Browse</strong> and <strong>Visual</strong> both render the Data Canvas module (with its Home / Data / Canvas / Help sub-tabs), while <strong>Source</strong> shows the plain JSON text',
          'New: file tree ➕ Create File → type <strong>Data Canvas</strong> (<code>.data</code>), or pick “New → Data Canvas” in the file tree / file view context menu; a new file opens as an <strong>empty canvas</strong> ready to model on',
          'Save: canvas changes are <strong>auto-saved after ~1.5s debounce</strong> back to its own <code>.data</code> file, and the 💾 toolbar button saves immediately; after saving, the open tab is synced (the Source view shows the new JSON at once) and other windows / tabs are notified to refresh',
          'Switching files: unsaved edits are <strong>written back silently</strong> before the next file loads, and an empty file clears the canvas (no leftovers from the previous file); closing the tab or leaving Knowledge Management writes back the same way',
          'Own window: right-click the file → Open gives the <strong>canvas only</strong> (no view switcher); to edit the JSON, use the Source view in Knowledge Management. <code>.data</code> is registered as a system file association, so double-clicking it opens this app',
          'Two uses: open a <code>.data</code> file as a canvas, or export one from the canvas toolbar as a <strong><code>.data</code> package</strong>, or drag a <code>.data</code> file into the canvas to import it as a <strong>sub-canvas node</strong> (both share the same shape: <code>models</code> + <code>activeModelId</code>)'
        ]
      },
      overview: {
        title: 'What is Data Canvas?',
        description: 'Data Canvas is a <strong>file type in Knowledge Management</strong> (<code>.data</code>) — it is no longer a top-level module and has no nav entry of its own: build <strong>no-code data models</strong> with nodes and links — table / parameter / chart / sub-canvas nodes with zoom, grid snap and one-click recompute; configure per-column <strong>form entry</strong> types (text / textarea / number / date / select / boolean) on the Data tab, and view charts on the Dashboard tab. Changes are <strong>auto-saved</strong> to its own <code>.data</code> file (debounced ~1.5s; 💾 saves immediately), and double-clicking a <code>.data</code> file in Knowledge Management opens this module and loads it.'
      },
      scenarios: {
        title: 'Typical Scenarios',
        items: [
          'Multi-unit reporting & decision support: units fill a shared template (or import Excel); model the rollup with table nodes and compare with chart nodes for <strong>cost estimation, budget allocation and option trade-offs</strong>',
          'Project / cost management: a ledger (budget, actual, variance), key parameters and trend charts — update once, the whole dashboard follows',
          'Research data: parameter nodes record conditions, table nodes record samples and measurements, chart nodes compare groups; export a package to back up or share',
          'Lightweight business ledgers: combine tables and sub-canvases into a data dictionary / ledger / report system instead of scattered Excel files'
        ]
      },
      steps: {
        title: 'How to Use',
        items: [
          'Open a <code>.data</code> file from the <strong>Knowledge Management</strong> file tree (the <strong>Browse</strong> / <strong>Visual</strong> view is the canvas module)',
          'On the <strong>Canvas</strong> tab, double-click empty space or press + to add nodes (table / parameter / chart / sub-canvas…), drag to arrange and link them to define data flow',
          'Enter data on the <strong>Data</strong> tab: set an input type per column (or import tables from Excel / Markdown); the sidebar switches records by title field',
          'View charts on the <strong>Dashboard</strong> tab (flow layout / free drag, layout lock); the canvas toolbar exports / imports a <code>.data</code> package'
        ]
      },
      notes: {
        title: 'Notes',
        items: [
          'Canvas files use the <code>.data</code> format: changes auto-save, and if the file goes missing you will be asked for a new location on the next save',
          'One canvas file can hold several data models, saved and restored together with the file; the exported package is for sharing or backup',
          'Canvases no longer open from <code>.task</code>: double-clicking an old canvas <code>.task</code> file (shaped like <code>{ "models": [...] }</code>) prompts you to switch to the <code>.data</code> extension — <strong>rename it to <code>.data</code> and put it in your workspace</strong> and Knowledge Management will open it as a canvas again (the contents are isomorphic, so renaming is all it takes)',
          'The canvas toolbar <strong>wraps</strong> with the panel width: in split view or a very narrow window the right-hand buttons are never clipped'
        ]
      }
    },
    agentScaffold: {
      overview: {
        title: 'What is the Agent Scaffold?',
        description: 'The <strong>Agent Scaffold</strong> is a <strong>universal Agent execution framework</strong> (the Harness): it runs table-driven batch work — and it is the <strong>only scaffold</strong> left, the former Batch Agent / Table Reasoning / Collect File / Collect Web scaffolds now being its <strong>four presets</strong> (legacy <code>.task</code> files convert automatically when opened). Each <code>.task</code> file is a standalone task (opened in a separate window with its own “Scaffold” view) that can be paused, resumed, or left running in the background; for programmatic tool calling switch the task preset to <strong>PTC Agent</strong> (available in chat / workflow / swarm too).'
      },
      scaffolds: {
        title: 'How to Configure the Agent Scaffold (Source × Execution × Output)',
        batch: {
          title: '⚡ Batch Agent (preset)',
          desc: 'Table source × Agent × Single result (result column): import a table and hand each row to an independent tool-using agent (concurrent execution, retries, filters and a <strong>Rerun ▾</strong> scope menu) — the classic form for batch writing, analysis or generation.'
        },
        file: {
          title: '📁 Collect File (preset)',
          desc: 'Folder source × Structured extraction: scan local files (optional extensions / excluded dirs), extract output fields file by file and merge into a data table by primary key — build lists from large document sets.'
        },
        collector: {
          title: '🌐 Collect Web (preset)',
          desc: 'Text source (one URL per line) × Fetch web pages × Structured extraction: page titles and discovered links are stored as row fields and followed within depth/page caps into new rows — scrape structured info from sites (the graph tab shows the crawl trail).'
        },
        tabreason: {
          title: '🎯 Table Reasoning (preset)',
          desc: 'Table source × Pure LLM × Structured extraction: reference row data in the task instruction and set a per-field instruction under “Output fields” (leave empty to infer from the field name), producing records row by row — batch labeling, field completion, risk rating; results land in the data table and export as a new sheet.'
        },
        presets: {
          title: 'Four Presets (one-click apply)',
          note: 'Apply from the “Preset” dropdown on the task page — it links source / execution / output and their parameters (imported rows are kept; editing any dimension switches back to “Custom”).'
        },
        pipeline: {
          title: '🧩 Agent Scaffold',
          desc: 'The <strong>Agent scaffold</strong>, evolved from Batch Agent. The task page splits into <strong>Source</strong>, <strong>Execution</strong> and <strong>Output</strong>: the source is a <strong>Table (import xlsx / csv)</strong>, a <strong>Folder (scan local files, one task row per file)</strong>, or <strong>Text (one entry per line: URLs, file paths or plain text)</strong>; execution is <strong>Agent (full session, with tools)</strong> — task instruction, concurrent agents — or <strong>Pure LLM (no tools)</strong>; output is <strong>Single result</strong> (agent → result column; pure LLM → write back to source-table columns) or <strong>Structured extraction</strong> (JSON per row merged into the data table by field / primary key — available for both Agent and Pure LLM); a single result is just the “one field” form of a structured result, and both share the export columns / runtime info settings, so switching never loses that selection; legacy “Table Reasoning” files open as Structured extraction (old write-back values become data-table records). The pure-LLM structured branch adds a <strong>Goal</strong> (supports {{column}} placeholders) and <strong>Content</strong> (row data / local file in a field / web page in a field — fetching is link crawling: page titles and discovered links are stored as row fields and followed into new rows by the follow policy Within depth/page caps). The <strong>Task page</strong> is frameless and title-free, laid out in three columns: left = one <strong>Run &amp; Settings</strong> card with the <strong>action bar merged at its top</strong> (Load / Save / Save as · Reset / Stop / Start, then the <strong>preset</strong> dropdown), middle = <strong>Input</strong> (Data selection on top, the Task instruction filling the rest), right = <strong>Output</strong> (narrow windows go straight to a single column — there is no in-between two-column state; all three panels fill the task page height and scroll inside when content is taller — the left Run &amp; Settings card scrolls as a whole) — the preset dropdown (Batch Agent / Table Reasoning / Collect Files / Collect Web) applies the configuration shape of a legacy scaffold in one click (any manual change switches it back to “Custom”), and <strong>Load</strong> can even open legacy .task files, converting them automatically (write-back values, task rows and collected data included). The imported table or scanned folder <strong>path</strong> appears under the Input panel (with the row count; hover for the full path); <strong>Row title</strong> under Run picks which field the details table shows at its left (none or one field, switchable while running); <strong>Output fields</strong> are edited as a full-width table (field name + inference instruction / description; structured extraction adds Required / PK columns) — column-by-column write-back and structured extraction <strong>share the same field list</strong>, so switching the output mode needs no re-configuring; the <strong>Input</strong> panel has two segments — <strong>Task instruction</strong> (the old template / goal unified; {{column}} placeholders rendered once per row, shared by all three execution modes) and <strong>Data selection</strong> (click a column to write / remove its {{column}} placeholder in the instruction; referenced columns are highlighted, with All / None; content fetching, value field and crawl settings live here too). The page splits into tabs: <strong>Task</strong> (setup and start), <strong>Details</strong> (one row per sub-task: status / start &amp; finish time / duration / reasoning steps / tokens (<strong>pure LLM inference counts per-row tokens too</strong>) / error; in structured mode the extracted fields, and in write-back mode the target columns, become the result columns — click a row for the full record (write-back results are editable as JSON in the row dialog) and extracted data; the batch can be <strong>stopped</strong> right from this tab), <strong>Results</strong> (preview &amp; export: the page shows exactly what “Export Excel” writes — the columns are configured under Output (a vertical list where you switch each source column, runtime info item such as row # / instruction / status / times / tokens, and each round’s result on or off and drag the handle to reorder them — that order is the export column order, and you can rename any column by clicking its name (used by the Results tab and the exported Excel; a renamed column still shows its original name); merged per task row in structured mode; the explanatory text of Output mode / Output fields / Export columns now lives in the hover title), results load <strong>progressively</strong> (scrolling to the bottom keeps loading), with full-text search, filtering by column and row-number jump highlighting, and any single result can be <strong>deleted</strong> individually; results are separate from task rows and rerunning structured extraction <strong>replaces that row’s previous records</strong> by default (switch to keep &amp; merge under Output → Rerun results); the leftmost <strong>Task row</strong> column links each result back to its task row; when the source table changes, “<strong>Sync source</strong>” re-reads it and re-attaches results by fingerprint / first value (new / changed / removed are all marked — click “new” / “changed” in the “+new ~changed -removed” toolbar summary to filter the table below (hover for column-level differences and the matching notes)) (click to open it in the Details tab), and when the source table changes (rows added / removed / edited) a re-import re-attaches results by <strong>row fingerprint</strong> and reports a new / changed / removed delta (only the row-count difference is reported when the positions cannot be determined reliably; changed rows keep their results on the same row (source data edited — rerun when you like); surplus results of deleted rows are deleted automatically (when the match looks unreliable they are only marked “removed” — the “Removed N” button on the Results tab filters down to them); when the Results count exceeds the task-row count, the line under the table breaks it down and the “Orphan N” button filters out results that belong to no task row (“Delete these” removes them; “Clear” only cancels the filter); “Sync results” rebuilds the results from the current task rows so the count and the data line up))), <strong>Graph</strong> (the crawl trajectory — nodes = pages, edges = who discovered whom, with a depth distribution — or the access path of any agent row — one “agent” node per row (purple) with edges to the sources it visited and the MCP services it called (a row that called no tool still shows as a single node); the toolbar shows a <strong>coloured-dot legend</strong> (click a dot to filter that type in/out) next to the view picker and node cap (default 2000; the graph opens with a wider initial view and, once the layout settles, is auto-framed and centred to include every node — manual zoom/pan turns that off); untick <strong>Enable graph tab</strong> under Run &amp; Settings to skip the projection and hide the tab entirely; the view is picked automatically for the task (web rows → crawl trajectory, otherwise process snapshots → access path), with an explanatory empty state) and <strong>Logs</strong> (a left-side nav lists the main log and each thread, with level filtering; the clear button sits in the nav header). Legacy batch / table-reasoning / collect-file / collect-web <code>.task</code> files open into this pipeline and convert automatically.'
        }
      },
      usage: {
        title: 'How to Use',
        items: [
          'Double-click a <code>.task</code> file in Knowledge Management (file tree / file view, search or right-click open) to open its dedicated “Scaffold” view in a <strong>separate window</strong>; “New → Scaffold” creates one too (an empty task skeleton is written and the window opens right away)',
          'One window serves exactly one .task (the file is isolated in its own window; opening the same file again focuses the existing window): the scaffold itself lives in that window — the Task / Details / Results / Graph / Logs tabs plus the status-bar Load / Save / Save as · Reset / Stop / Start actions — and everything is written back to this file',
          '“New → Scaffold” writes an empty task skeleton (<code>scaffold: pipeline</code>); pick one of the four presets on the task page (Batch Agent / Table Reasoning / Collect File / Collect Web), or keep “Custom”',
          '<strong>Keep in file</strong> (Run &amp; Settings) lets you tick <strong>Graph data</strong> (per-row process snapshots that the graph and row details are built from) and/or <strong>Run logs</strong> so they are written into the task file (still viewable after reopening); both are <strong>off by default</strong> to keep the file small',
          '<strong>Rounds</strong> on the task page let one batch of rows run several times: a new round keeps the rows (status back to pending) and the current config snapshot, so you can change settings / instruction and run again — switch rounds from the dropdown (results / graph / export always follow the active round)',
          '<strong>Previous rounds</strong> chips under Data selection (e.g. <code>{{Round 1.result}}</code> / <code>{{Round 1.field}}</code>) inject an earlier round’s output for the <strong>same row</strong> into this round’s instruction; tick the rounds you want in Export columns to place their results <strong>side by side</strong> for comparison',
          'The <strong>⑂</strong> button next to the rounds is a <strong>chained round</strong>: it expands this round’s results into the next round’s task rows (structured records become one row each) — good for expand-then-refine; with two or more rounds the <strong>Compare</strong> tab shows the same rows side by side (⚠ differ, ? missing result; the Rounds chips above show / hide a round, at least one is always kept); click any output cell to preview it rendered as Markdown in a popup (titled with its round), and the table always lists every row — including rows that exist only in another round, shown as — where a round has no result',
          'Clicking a table row opens the <strong>row detail</strong> in three tabs — <strong>Task / Process / Output</strong> (tabs on the left, the run counters — start / end / duration / steps / tokens — on the right; the tab you pick is kept when you open other rows, so checking many rows for the same kind of info needs no re-clicking): Task = the prompt actually sent after substitution, Process = reasoning steps and tool calls (same tool box as the home chat: <strong>a single-line summary by default</strong>, click to expand arguments and result; live while running), Output = extracted data / written-back columns / result text (while running it <strong>streams the rendered text</strong> instead of the Markdown source; Markdown is laid out compactly for the preview size instead of being stretched out); the <strong>bottom button bar</strong> holds, left to right, the tab action (Copy / Edit — Save + Cancel while editing) → <strong>status dropdown</strong> (Pending / Completed / Failed / Skipped — status only, results are kept; “Pending” = to-run, press Start on the Task tab to run it; running rows cannot be changed) → <strong>Stop this row</strong> (shown while that row is running: its session/request is cancelled and the row is marked “Skipped”; <strong>other rows and the batch keep running</strong>) → <strong>Rerun this row</strong> (shown whenever it is not running: while the batch runs it jumps the queue, otherwise it is marked pending and started right away) → Delete, with Close on the right (buttons and the dropdown share the same height; the Operations column of the table shows plain status text only, no buttons',
          'The <strong>Filter</strong> button on the Details tab opens one panel with every condition — status / search / result / row range / steps / took (steps and duration take <strong>&lt; ≤ &gt; ≥ =</strong> plus a value; never-run rows count as 0 steps / 0 seconds, durations are seconds by default but accept 90 / 1.5m / 2m30s) — and it shows how many rows <strong>match</strong> live; the matched rows can be <strong>marked in bulk</strong> as Pending (= queued for the next Start) / Skipped / Completed / Failed, or rerun right away with “Rerun matched” (mark pending + run)',
          'Configure the three dimensions — <strong>Source</strong> (table / folder / text), <strong>Execution</strong> (agent / pure LLM) and <strong>Output</strong> (single result / structured extraction) — then click Start',
          'Click the run / execute button in the window — runs can be stopped and resumed later (progress is preserved), and everything is saved to its own <code>.task</code> file (reopen that file to continue)',
        ]
      }
    },
    agentSwarm: {
      overview: {
        title: 'What is Swarm (multi-agent collaboration)?',
        description: 'Swarm is a <strong>home chat mode</strong>: switch the mode selector to “Swarm” and <strong>multiple agents join one conversation</strong> — send a task and members reply in turn, or type <code>@member-name</code> to call a single member. <strong>Members are Agent presets</strong> (managed under Settings → Agents → Presets): editing a preset edits the member, and a conversation only stores which presets it uses — there is no separate swarm plan file. Member replies, tool calls and reasoning render <strong>exactly like every other mode</strong> in the same conversation, and are saved with it.'
      },
      steps: {
        title: 'How to Use',
        step1: { title: 'Prepare Agent presets', desc: 'Create members under Settings → Agents → Presets: each preset carries its system prompt, model, temperature and capabilities (tools / skills / knowledge base / MCP). Members are the presets themselves — no duplicate setup needed.' },
        step2: { title: 'Switch to Swarm mode', desc: 'Pick “Swarm” in the <strong>mode selector</strong> at the bottom-left of the home input area; a <strong>member chip</strong> appears — click it to tick the presets that join the task (<strong>tick order = speaking order</strong>):', capabilities: ['📂 Read Files', '💻 Execute Code', '🔎 Web Search', '🗄️ Knowledge Base', '🖥️ Browse Web', '✍️ Write Files', '🔌 MCP Services', '🤖 Skills'] },
        step3: { title: 'Choose run mode', desc: 'Next to the member chip, the <strong>run mode</strong> dropdown offers three options: All respond / Debate / Team. It is saved with the conversation.' },
        step4: { title: 'Send a Task & Collaborate', desc: 'Type a task at the bottom and send (typing <code>@member-name</code> pops up candidates and calls that member directly). Without @, members speak in turn according to the mode; members can <code>@colleague</code> in replies to pull others in, or spawn a <strong>generic subagent</strong>. Generic / custom members automatically carry enabled global MCP services plus read/write, search, code and skill capabilities.' },
        step5: { title: 'Watch results', desc: 'Member replies are ordinary messages in the conversation: Markdown body with <strong>inline tool-call / thinking cards</strong> (identical to Agent mode) that expand to show args and results. ■ stops a running task, and a chat title is generated automatically when the task finishes.' }
      },
      modes: {
        title: 'Run Modes (input bar dropdown)',
        'auto-mention': { name: 'All respond', desc: 'Every selected member answers the task in turn; members may also @colleagues in their reply. Default.' },
        debate: { name: 'Debate', desc: 'Members debate the task over rounds, then the host gives a neutral summary. Best for comparing options.' },
        team: { name: 'Team (Lead-led)', desc: 'The first member acts as Lead: it splits the goal into tasks, assigns them by dependency and delivers a summary. This mode has a single top row (chat name on the left, workbench tabs on the right); Messages, Flow, Roster, Tasks and Comm are full-width sibling tabs; the Flow view shows task dependencies and member status vertically; the Roster shows per-member tokens / tool count / last activity (a running member idle for over 90s is flagged); a stopped episode can be resumed from the Tasks tab; the Tasks tab also has a concurrency gate (1-8), and clicking a task jumps to its messages (and back); long outputs are saved as artifacts (openable card in the chat, 📎 chips on the task card) so full text stays out of context; when an episode ends the task board, flow, comms and artifacts are kept (also across reloads), and the selector at the top lets you review earlier episodes (read-only).' }
      }
    },
    browser: {
      overview: {
        title: 'What is the Browser?',
        description: 'The browser is a <strong>built-in web browser in its own window</strong> (separate from Knowledge Management): multi-tab browsing, bookmarks and offline page saving — and crucially it can be <strong>driven by AI</strong>. Agents can open pages, extract content, fill forms and click, turning the web into a usable information source.'
      },
      features: {
        title: 'Capabilities',
        tabs: { name: 'Multi-tab browsing', desc: 'Tabs can be reordered by drag and closed on hover; the address bar accepts URLs or search keywords.' },
        aiTab: { name: 'AI session tabs', desc: 'Pages opened by agents use a separate “AI session tab” (marked with a robot icon) and are recycled when idle — click the tab to keep it.' },
        bookmarks: { name: 'Bookmarks', desc: 'Bookmark pages; they are stored in the “Browser settings → Save folder” directory and can be re-opened, edited or removed from the bookmarks panel.' },
        save: { name: 'Save full page', desc: 'Save the current page (including images and styles) as offline HTML for archiving and later reading.' },
        panel: { name: 'Right settings rail', desc: 'Shows the current tab AI state (browsing / AI / acting) and offers: open in system browser, save full page, recycle AI tabs, console, allow JS execution, cache cleanup.' }
      },
      steps: {
        title: 'How to Use',
        items: [
          { title: 'Open the browser', desc: 'Open the <strong>dedicated window</strong> from the browser entry, or let the AI launch it automatically when a conversation needs a web page.' },
          { title: 'Browse & search', desc: 'Type a URL or keywords in the address bar and press Enter; use ➕ for a new tab, drag to reorder, click ✕ to close.' },
          { title: 'Let AI drive pages', desc: 'Ask the agent to open / read a page (e.g. “open this page and extract the key points”); it works in an AI session tab and brings results back to the conversation.' },
          { title: 'Bookmark & save', desc: 'Use ⭐ to bookmark the current page; click “Save full page (offline HTML)” in the right rail to archive it.' }
        ]
      },
      tips: {
        title: 'Notes',
        items: [
          'Browser settings include a <strong>home page</strong> (loaded on the first tab when opened manually; AI calls unaffected) and a <strong>save folder</strong> (where bookmarks and offline pages go; empty = current workspace root).',
          'For safety, <strong>allowing AI to run JS</strong> (browser_eval) is off by default; enable it in the right rail when needed.',
          'AI session tabs are <strong>recycled when idle</strong> to avoid clutter; click a tab to keep it.',
          'Cache management sits at the bottom of the right rail — inspect the cache size and clear it in one click.',
          'The Browser Agent is also a <strong>built-in MCP server (builtin-browser)</strong>: agents drive it via browser_* tools (navigate, new / switch / close tabs, read text / Markdown / HTML, click, type, scroll, screenshot). Screenshots come back as <strong>compressed JPEG</strong> (max side 1024) so a single image cannot blow up the model context. Manage it under Settings → Tools → MCP. The <strong>drawio (builtin-drawio)</strong> built-in server likewise lets agents create, inspect, edit, lay out and export local .drawio diagrams through 44 drawio_* tools.',
          'Local <strong>.html / .htm</strong> pages in Knowledge Management open in the <strong>built-in browser</strong> by default (double-click / search / any view, same as “Open File”), where AI can keep operating on them or extract text; use the right-click “Open → pick a view” menu to preview them in a file view or edit the source.'
        ]
      }
    },
    faq: [],
    learning: {
      overview: {
        title: 'Mastery Learning: Remember & Review',
        desc: 'The <strong>Learning</strong> module turns saved knowledge bases (<code>.kb</code>) into content you can “master”: mastery tracking and spaced repetition over files and ontology entities, plus flashcards, a mistake book and exams — closing the practice → review → exam loop. Learning records (answers plus generated AI explanations) live in a separate <code>&lt;name&gt;.learning</code> next to each KB and are never written into <code>.kb</code>; after a KB update old records are marked “stale” and kept.'
      },
      viewsTitle: 'Six views',
      view: {
        overview: { name: 'Overview', desc: 'Action center: next-step suggestions; overall mastery / accuracy / total practice in the bottom status bar; streak & 7/30-day trend' },
        map: { name: 'Map', desc: 'Three axes: by file / by entity (horizontal progress bar at card bottom; claim mastered (test-out), switch knowledge type, clear stale or relearn) / ontology graph (entity-relation graph coloured by mastery; the scope dropdown offers all entities / practised only / all entities + questions / practised only + questions / slices + questions / files + questions, where questions attach to the entities, slices or source files they are based on; click a node for details or to practice; the legend bar offers node spacing (tight / normal / wide / extra, default wide), a show-count picker (200 / 500 / 1000 / 2000 / 5000 / 10000 / 20000, default 2000) capping how many nodes of each kind are drawn, and a label picker (auto / always / never; labels shrink automatically as node count grows); the legend states shown / total)' },
        review: { name: 'Review', desc: 'Due queue (recent / consecutive misses first) with one-click due review' },
        mistakes: { name: 'Mistakes', desc: 'List on the left, detail on the right: reference (source slice), reason tagging (memory / concept / procedure / careless), AI explain, retry' },
        solver: { name: 'Q&A', desc: 'Ask about the current KB directly, running the same agent loop as Home (it calls kb_search across multiple rounds, plus search_files semantic/keyword or read_file when needed); streams the answer and shows execution steps (tools called and hit counts), answers only from slices with [n] citations that can be expanded for verification.' },
        exam: { name: 'Exam', desc: 'Four ways to build a paper (random / selected slices / manual / mimic exam) with single / multi / true-false / essay; objective graded locally, essays by AI; optionally feed each answer into its file learning object' }
      },
      mech: { title: 'Core mechanics' },
      step1: {
        title: 'Build a KB first, then study',
        desc: 'After slicing / vectorizing and saving a <code>.kb</code> in Knowledge Processing, open Learning and pick that KB at the top-right. The dropdown scans <strong>every workspace and its subfolders</strong> (manage workspaces in Settings → General → Basic → Path Settings), so a <code>.kb</code> outside the current workspace still shows up; duplicates get their folder appended.'
      },
      step2: {
        title: 'Mastery & gate',
        desc: 'Each file derives mastery (0–100%) from answer accuracy; <strong>90%</strong> clears the gate = “mastered”, while misses pull it back. Unfinished items stay “learning” and can be practiced anytime on the map.'
      },
      step3: {
        title: 'Typed spaced repetition',
        desc: 'Objects follow per-type review intervals: memory 1/3/7/14/30/60 d, procedure & concept 3/7/14/30(60) d, design 14/28/60 d. Correct answers lengthen intervals (2 consecutive = +2 steps); misses shorten and reset them. Due items enter Review (recent misses first). <strong>Practice is not due-gated</strong> — you can drill any time.'
      },
      step4: {
        title: 'Claim mastered / stale / relearn',
        desc: 'Map cards can claim mastered (test-out) to skip content you already know, or reset to relearn; after a KB update stale records can be cleared or reset.'
      },
      step5: {
        title: 'Reason tagging & exam feed',
        desc: 'Tag the reason of each miss (memory / concept / procedure / careless) for review; when grading an exam you can feed every answer into the source file learning object.'
      },
      step6: {
        title: 'Explain & mimic exam',
        desc: 'A practice card has three tabs at the bottom: <strong>Answer</strong>, <strong>Explain</strong> (streamed live as Markdown; AI breaks the point into core idea / prerequisites / step-by-step reasoning / common confusions plus a knowledge map) and <strong>Slices</strong> (source slices rendered as Markdown); mistake details offer the same AI explain. All learning-module Markdown uses the same typography as Home, and explanations/diagram labels prefer Chinese, switching to English only when the KB itself is English (or the UI is in English). <strong>Mimic exam</strong> lets you import or paste a real exam, analyzes its question mix and wording style (profile stored locally per KB), then writes new questions in that style.'
      }
    },
    footer: {
      tip: {
        label: '💡 Tip:',
        text: 'Start with simple features, then combine them gradually. Check help anytime!'
      },
      links: {
        feedback: 'Feedback',
        source: 'Source Code',
        mineru: 'MinerU Converter'
      }
    }
  }
}
</script>

<style scoped>
.help-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  overflow: hidden;
  position: relative;
}

/* ====== 顶部标签导航（浮动固定在顶部） ====== */
.help-top-tabs {
  display: flex;
  align-items: center;
  flex-wrap: wrap; /* 窗口变窄时自动换行，避免后面的标签被挤出 */
  gap: 2px;
  padding: 8px;
  padding-bottom: 0px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
  position: sticky;
  top: 0;
  z-index: 100;
}

.help-top-tabs .top-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  font-size: 11px;
  border: 1px solid transparent !important;
  border-bottom: none !important;
  background: none !important;
  color: var(--fontColor);
  cursor: pointer;
  border-radius: 5px 5px 0 0;
  transition: all 0.15s;
  white-space: nowrap;
  flex-shrink: 0; /* 保持固定宽度，不被压缩 */
  opacity: 0.6;
}

.help-top-tabs .top-tab:hover {
  opacity: 1;
  background: var(--backgroundColor) !important;
}

.help-top-tabs .top-tab.active {
  opacity: 1;
  background: var(--backgroundColor) !important;
  border-color: var(--borderColor) !important;
  color: var(--fontActiveColor);
  font-weight: 600;
  margin-bottom: -1px;
}

.help-top-tabs .top-tab-icon {
  font-size: 13px;
}

.help-top-tabs .top-tab-label {
  font-size: 11px;
}

/* 窄窗口下让导航标签更紧凑，减少换行占用的高度 */
@media (max-width: 720px) {
  .help-top-tabs {
    padding: 6px 6px 0;
    gap: 1px;
  }
  .help-top-tabs .top-tab {
    padding: 4px 7px;
    font-size: 10px;
    gap: 3px;
  }
  .help-top-tabs .top-tab-icon {
    font-size: 12px;
  }
  .help-top-tabs .top-tab-label {
    font-size: 10px;
  }
}

/* ====== 主要内容区 ====== */
.help-main {
  flex: 1;
  height: 100%;
  overflow-y: auto;
  padding: 10px 16px;
}

.help-section {
  margin-bottom: 0;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--borderColor);
}

.section-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.section-title-content h2 {
  font-size: 15px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin: 0;
}

.section-desc {
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.6;
  margin: 2px 0 0 0;
}

/* 快速上手指南 */
.quick-steps {
  margin: 8px 0;
}

.overview-card {
  background: linear-gradient(135deg, rgba(var(--fontActiveColor-rgb), 0.08), rgba(var(--fontActiveColor-rgb), 0.03));
  border: 1px solid var(--borderColor);
  border-left: 3px solid var(--fontActiveColor);
  border-radius: 6px;
  padding: 10px 14px;
  margin-bottom: 10px;
  font-size: 12px;
  line-height: 1.6;
}

.overview-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.overview-head i {
  color: var(--fontActiveColor);
  font-size: 16px;
  line-height: 1.6;
  flex-shrink: 0;
  margin-top: 1px;
}

.overview-card p {
  margin: 0;
  flex: 1;
}

.overview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}

.ov-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  line-height: 1;
  color: var(--fontActiveColor);
  background: rgba(var(--fontActiveColor-rgb), 0.1);
  border: 1px solid rgba(var(--fontActiveColor-rgb), 0.22);
  border-radius: 10px;
  padding: 3px 8px;
}

.ov-tag i {
  font-size: 10px;
}

.quick-step-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 10px;
  align-items: stretch;
}

.quick-step {
  background-color: var(--menuColor);
  border-radius: 8px;
  padding: 10px 12px;
  border: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.quick-step:hover {
  border-color: var(--fontActiveColor);
  box-shadow: 0 1px 6px rgba(var(--fontActiveColor-rgb), 0.12);
}

.quick-step-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px dashed var(--borderColor);
}

.step-icon {
  font-size: 14px;
  flex-shrink: 0;
  line-height: 1;
}

.quick-step h4 {
  font-size: 12px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-step ul {
  margin: 0;
  padding-left: 14px;
  font-size: 11px;
  flex: 1;
}

.quick-step li {
  margin-bottom: 3px;
  line-height: 1.5;
  color: var(--fontColor);
}

.section-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.content-card {
  background-color: var(--menuColor);
  border-radius: 8px;
  padding: 10px 12px;
  border: 1px solid var(--borderColor);
}

.content-card h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin: 0 0 6px 0;
}

.content-card p {
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 6px;
}

/* 各视图使用要点的子标题 */
.view-tips-name {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin: 10px 0 4px 0;
}
.view-tips-name i {
  font-size: 11px;
  opacity: 0.8;
}

.example-box {
  background-color: rgba(var(--fontActiveColor-rgb), 0.05);
  border-radius: 6px;
  padding: 8px 10px;
  margin-top: 6px;
  border-left: 3px solid var(--fontActiveColor);
}

.example-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin-bottom: 4px;
}

.open-mode-list {
  margin: 0;
  padding-left: 16px;
  font-size: 11px;
  line-height: 1.6;
}

.open-mode-list li {
  margin-bottom: 2px;
}

.step-card {
  display: flex;
  gap: 10px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--borderColor);
}

.step-card:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.step-number {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--fontActiveColor) 0%, #667eea 100%);
  color: white;
  border-radius: 50%;
  font-weight: 600;
  font-size: 12px;
  flex-shrink: 0;
}

.step-details h4 {
  font-size: 12px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin: 0 0 4px 0;
}

.step-details ul {
  margin: 0;
  padding-left: 14px;
  font-size: 11px;
}

.step-details li {
  margin-bottom: 2px;
  line-height: 1.4;
}

.flow-diagram {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 6px 0;
  padding: 0 6px;
  flex-wrap: wrap;
}

.flow-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  min-width: 50px;
}

.flow-icon {
  font-size: 16px;
  margin-bottom: 2px;
}

.flow-text {
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.8;
}

.flow-arrow {
  color: var(--fontActiveColor);
  font-size: 13px;
  font-weight: bold;
}

.guide-step {
  display: flex;
  gap: 10px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--borderColor);
}

.guide-step:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.guide-number {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-radius: 50%;
  font-weight: 600;
  font-size: 11px;
  flex-shrink: 0;
  margin-top: 1px;
}

.guide-content strong {
  display: block;
  margin-bottom: 3px;
  color: var(--fontActiveColor);
  font-size: 12px;
}

.guide-content p,
.guide-content ul {
  font-size: 11px;
  margin: 0;
  padding-left: 14px;
}

.tool-tip {
  background-color: rgba(var(--fontActiveColor-rgb), 0.1);
  border-radius: 4px;
  padding: 5px 8px;
  margin-top: 4px;
  font-size: 10px;
}

.use-cases {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.use-case {
  background-color: rgba(var(--fontActiveColor-rgb), 0.1);
  color: var(--fontActiveColor);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 10px;
}

.nodes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 6px;
  margin: 6px 0;
}

/* 设置章节的导航总览：分组标题 + 逐条清单（比方块卡片更紧凑、更像分级文档） */
.settings-tree-group { margin: 10px 0 0 2px; }
.settings-tree-group h4 {
  font-size: 12px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin: 0 0 4px 0;
  padding-bottom: 3px;
  border-bottom: 1px dashed var(--borderColor);
}
.settings-tree-list {
  list-style: none;
  margin: 0 0 0 2px;
  padding: 0 0 0 12px;
  border-left: 1px solid var(--borderColor);
}
.settings-tree-list li { margin: 4px 0; line-height: 1.6; }
.settings-tree-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin-right: 6px;
}
.settings-tree-desc { font-size: 10px; color: var(--fontColor); opacity: 0.8; }

.node-item {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  align-items: center;
  column-gap: 8px;
  padding: 6px 8px;
  background-color: var(--backgroundColor);
  border-radius: 6px;
  border: 1px solid var(--borderColor);
}

.node-item:hover {
  border-color: var(--fontActiveColor);
}

.node-icon {
  grid-row: 1 / 3;
  align-self: center;
  font-size: 14px;
}

.node-name {
  font-size: 11px;
  font-weight: 500;
  color: var(--fontActiveColor);
  margin-bottom: 2px;
}

.node-desc {
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.8;
}

/* 「视图一览」的分组小标题（11 种视图 / 5 种专用视图） */
.views-group + .views-group {
  margin-top: 16px;
}

.views-group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin: 2px 0 6px 2px;
  padding-bottom: 3px;
  border-bottom: 1px dashed var(--borderColor);
}

/* 设计参考开源项目区：更详细的列表式展示 */
.credit-card p { line-height: 1.7; }
.credit-list { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.credit-item { border: 1px solid var(--borderColor); border-radius: 6px; padding: 8px 10px; background-color: var(--backgroundColor); }
.credit-head { display: flex; align-items: center; gap: 6px; }
.credit-head i { color: var(--fontActiveColor); }
.credit-head a { color: var(--fontActiveColor); font-weight: 500; font-size: 12px; text-decoration: none; }
.credit-head a:hover { text-decoration: underline; }
.credit-blurb { font-size: 11px; color: var(--fontActiveColor); opacity: 0.9; margin: 4px 0 2px; }
.credit-points { margin: 0; padding-left: 18px; }
.credit-points li { font-size: 10.5px; line-height: 1.75; color: var(--fontColor); opacity: 0.85; }

.workflow-example {
  margin-top: 6px;
}

.example-step {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}

.example-number {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-radius: 50%;
  font-weight: 600;
  font-size: 11px;
  flex-shrink: 0;
  margin-top: 1px;
}

.example-content strong {
  display: block;
  margin-bottom: 2px;
  color: var(--fontActiveColor);
  font-size: 12px;
}

.example-content p {
  font-size: 11px;
  margin: 3px 0;
}

.node-tags {
  display: flex;
  gap: 4px;
  margin-top: 3px;
  flex-wrap: wrap;
}

.node-tag {
  background-color: rgba(var(--fontActiveColor-rgb), 0.1);
  color: var(--fontActiveColor);
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 10px;
}

.flow-simple {
  background: linear-gradient(135deg, var(--fontActiveColor) 0%, #667eea 100%);
  color: white;
  padding: 5px 10px;
  border-radius: 4px;
  font-weight: 500;
  text-align: center;
  margin: 6px 0;
  font-size: 11px;
}

/* 更新日志（内容来自根目录 CHANGELOG.md / CHANGELOG.en.md 的 Markdown 渲染） */
.changelog-tip-box {
  margin-bottom: 10px;
}

.changelog-body {
  font-size: 12px;
  line-height: 1.6;
  color: var(--fontColor);
  word-break: break-word;
}

/* ⚠️ 更新日志内容是 v-html 注入的，不带 scoped 属性 → 子元素样式必须用 :deep()，否则不生效 */
.changelog-body :deep(h1) {
  display: none;
}

.changelog-body :deep(h2) {
  font-size: 13px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin: 14px 0 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--borderColor);
}

.changelog-body :deep(h2:first-of-type) {
  margin-top: 2px;
}

.changelog-body :deep(h3) {
  font-size: 12px;
  font-weight: 600;
  color: var(--fontActiveColor);
  margin: 10px 0 4px;
}

.changelog-body :deep(p) {
  margin: 6px 0;
}

.changelog-body :deep(ul) {
  margin: 0 0 6px;
  padding-left: 18px;
}

.changelog-body :deep(li) {
  margin: 3px 0;
}

.changelog-body :deep(code) {
  font-family: Consolas, Monaco, monospace;
  font-size: 11px;
  padding: 0 3px;
  border-radius: 3px;
  background-color: var(--menuColor);
  border: 1px solid var(--borderColor);
}

.changelog-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--borderColor);
  margin: 12px 0;
}

.changelog-body :deep(blockquote) {
  margin: 6px 0;
  padding: 4px 8px;
  border-left: 3px solid var(--borderColor);
  border-radius: 0 4px 4px 0;
  background-color: var(--menuColor);
  color: var(--fontActiveColor);
}

.main-footer {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--borderColor);
}

.footer-content {
  text-align: center;
}

.footer-tip {
  font-size: 11px;
  margin-bottom: 8px;
  color: var(--fontColor);
  opacity: 0.9;
}

.footer-links {
  display: flex;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}

.footer-links a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--fontActiveColor);
  font-size: 11px;
  text-decoration: none;
  padding: 3px 8px;
  border-radius: 4px;
}

.footer-links a:hover {
  background-color: var(--menuActiveColor);
  text-decoration: none;
}

code {
  background-color: rgba(255, 255, 255, 0.1);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: 'Consolas', monospace;
  font-size: 11px;
  color: var(--fontActiveColor);
}

a {
  color: var(--fontActiveColor);
  text-decoration: none;
  font-weight: 500;
}

a:hover {
  text-decoration: underline;
}
</style>
