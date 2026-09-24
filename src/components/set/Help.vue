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

            <div class="content-card">
              <h3>{{ t('aiChat.concept.title') }}</h3>
              <p v-html="t('aiChat.concept.lead')"></p>
              <ul class="open-mode-list">
                <li v-for="(item, i) in t('aiChat.concept.items')" :key="i" v-html="item"></li>
              </ul>
            </div>

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
              <h3>{{ t('knowledge.views.title') }}</h3>
              <div class="nodes-grid">
                <div class="node-item" v-for="v in knowledgeViews" :key="v.id">
                  <div class="node-icon">{{ v.icon }}</div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`knowledge.views.${v.key}.name`) }}</div>
                    <div class="node-desc">{{ t(`knowledge.views.${v.key}.desc`) }}</div>
                  </div>
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

            <!-- 文件打开方式：新窗口打开 / 窗口内打开 -->
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
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong v-html="t('knowledge.openMode.inner.name')"></strong>
                  <p v-html="t('knowledge.openMode.inner.desc')"></p>
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

            <!-- draw.io 图表（.drawio / .dio 文件专属绘图视图） -->
            <div class="content-card">
              <h3>{{ t('knowledge.drawio.title') }}</h3>
              <p v-html="t('knowledge.drawio.overview')"></p>
              <div class="guide-step">
                <span class="guide-number">1</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.drawio.step1.title') }}</strong>
                  <p v-html="t('knowledge.drawio.step1.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">2</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.drawio.step2.title') }}</strong>
                  <p v-html="t('knowledge.drawio.step2.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">3</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.drawio.step3.title') }}</strong>
                  <p v-html="t('knowledge.drawio.step3.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">4</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.drawio.step4.title') }}</strong>
                  <p v-html="t('knowledge.drawio.step4.desc')"></p>
                </div>
              </div>
              <div class="guide-step">
                <span class="guide-number">5</span>
                <div class="guide-content">
                  <strong>{{ t('knowledge.drawio.step5.title') }}</strong>
                  <p v-html="t('knowledge.drawio.step5.desc')"></p>
                </div>
              </div>
              <div class="example-box">
                <div class="example-title">{{ t('knowledge.drawio.note.title') }}</div>
                <p v-html="t('knowledge.drawio.note.text')"></p>
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

        <!-- 工作流编辑器 -->
        <section id="workflow" class="help-section" v-show="activeSection === 'workflow'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-stumbleupon"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.workflow.title') }}</h2>
              <p class="section-desc">{{ t('sections.workflow.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
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
              <h3>{{ t('workflow.example.title') }}</h3>
              
              <div class="workflow-example">
                <div class="example-step">
                  <div class="example-number">1</div>
                  <div class="example-content">
                    <strong>{{ t('workflow.example.step1.title') }}</strong>
                    <div class="node-tags">
                      <span v-for="(tag, index) in t('workflow.example.step1.tags')" 
                            :key="index" 
                            class="node-tag">{{ tag }}</span>
                    </div>
                  </div>
                </div>

                <div class="example-step">
                  <div class="example-number">2</div>
                  <div class="example-content">
                    <strong>{{ t('workflow.example.step2.title') }}</strong>
                    <p>{{ t('workflow.example.step2.description') }}</p>
                    <div class="flow-simple">{{ t('workflow.example.step2.flow') }}</div>
                  </div>
                </div>

                <div class="example-step">
                  <div class="example-number">3</div>
                  <div class="example-content">
                    <strong>{{ t('workflow.example.step3.title') }}</strong>
                    <ul>
                      <li v-for="(item, index) in t('workflow.example.step3.items')" :key="index">{{ item }}</li>
                    </ul>
                  </div>
                </div>
              </div>
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
            </div>

            <div class="content-card" v-for="g in settingGroups" :key="g.groupKey">
              <h3>{{ t(`settings.groups.${g.groupKey}.title`) }}</h3>
              <div class="nodes-grid">
                <div class="node-item" v-for="c in g.children" :key="c.key">
                  <div class="node-icon"><i class="fa" :class="c.icon"></i></div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`settings.groups.${g.groupKey}.items.${c.key}.name`) }}</div>
                    <div class="node-desc" v-html="t(`settings.groups.${g.groupKey}.items.${c.key}.desc`)"></div>
                  </div>
                </div>
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
              <div class="nodes-grid">
                <div class="node-item">
                  <div class="node-icon">🌐</div>
                  <div class="node-info">
                    <div class="node-name">{{ t('settings.builtinMcp.browser.name') }}</div>
                    <div class="node-desc" v-html="t('settings.builtinMcp.browser.desc')"></div>
                  </div>
                </div>
                <div class="node-item">
                  <div class="node-icon">📄</div>
                  <div class="node-info">
                    <div class="node-name">{{ t('settings.builtinMcp.office.name') }}</div>
                    <div class="node-desc" v-html="t('settings.builtinMcp.office.desc')"></div>
                  </div>
                </div>
                <div class="node-item">
                  <div class="node-icon">📐</div>
                  <div class="node-info">
                    <div class="node-name">{{ t('settings.builtinMcp.drawio.name') }}</div>
                    <div class="node-desc" v-html="t('settings.builtinMcp.drawio.desc')"></div>
                  </div>
                </div>
                <div class="node-item">
                  <div class="node-icon">📚</div>
                  <div class="node-info">
                    <div class="node-name">{{ t('settings.builtinMcp.literature.name') }}</div>
                    <div class="node-desc" v-html="t('settings.builtinMcp.literature.desc')"></div>
                  </div>
                </div>
                <div class="node-item">
                  <div class="node-icon">🐘</div>
                  <div class="node-info">
                    <div class="node-name">{{ t('settings.builtinMcp.postgres.name') }}</div>
                    <div class="node-desc" v-html="t('settings.builtinMcp.postgres.desc')"></div>
                  </div>
                </div>
              </div>
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

        <!-- 数据画布（顶层模块） -->
        <section id="data-canvas" class="help-section" v-show="activeSection === 'data-canvas'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-object-group"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.data-canvas.title') }}</h2>
              <p class="section-desc">{{ t('sections.data-canvas.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
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

        <!-- Agent脚手架 通用执行框架 -->
        <section id="agent-scaffold" class="help-section" v-show="activeSection === 'agent-scaffold'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-deviantart"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.agent-scaffold.title') }}</h2>
              <p class="section-desc">{{ t('sections.agent-scaffold.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
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

        <!-- 待办管理 -->
        <section id="todo" class="help-section" v-show="activeSection === 'todo'">
          <div class="section-header">
            <div class="section-icon"><i class="fa fa-lightbulb-o"></i></div>
            <div class="section-title-content">
              <h2>{{ t('sections.todo.title') }}</h2>
              <p class="section-desc">{{ t('sections.todo.subtitle') }}</p>
            </div>
          </div>

          <div class="section-content">
            <div class="content-card">
              <h3>{{ t('todo.overview.title') }}</h3>
              <p v-html="t('todo.overview.description')"></p>
            </div>

            <div class="content-card">
              <h3>{{ t('todo.views.title') }}</h3>
              <div class="nodes-grid">
                <div class="node-item" v-for="v in todoViews" :key="v.id">
                  <div class="node-icon">{{ v.icon }}</div>
                  <div class="node-info">
                    <div class="node-name">{{ t(`todo.views.${v.key}.name`) }}</div>
                    <div class="node-desc">{{ t(`todo.views.${v.key}.desc`) }}</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="content-card">
              <h3>{{ t('todo.tips.title') }}</h3>
              <template v-for="v in todoTips" :key="v.key">
                <h4 class="view-tips-name"><i :class="'fa ' + v.icon"></i> {{ t(`todo.tips.${v.key}.name`) }}</h4>
                <div class="guide-step" v-for="s in v.steps" :key="s">
                  <span class="guide-number">{{ s }}</span>
                  <div class="guide-content">
                    <strong>{{ t(`todo.tips.${v.key}.step${s}.title`) }}</strong>
                    <p>{{ t(`todo.tips.${v.key}.step${s}.desc`) }}</p>
                  </div>
                </div>
              </template>
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
const sections = ref([
  { id: 'quick-start', icon: 'fa-home' },
  { id: 'ai-chat', icon: 'fa-comment' },
  { id: 'knowledge', icon: 'fa-book' },
  { id: 'know-rag', icon: 'fa-stack-overflow' },
  { id: 'learning', icon: 'fa-graduation-cap' },
  { id: 'workflow', icon: 'fa-stumbleupon' },
  { id: 'data-canvas', icon: 'fa-object-group' },
  { id: 'agent-scaffold', icon: 'fa-deviantart' },
  { id: 'browser', icon: 'fa-globe' },
  { id: 'todo', icon: 'fa-lightbulb-o' },
  { id: 'settings', icon: 'fa-cogs' },
  { id: 'changelog', icon: 'fa-history' },
  { id: 'credits', icon: 'fa-github' }
])

// 节点列表（带key用于国际化；图标与软件工作流画布一致，均为 fa-icon）
const nodes = ref([
  { id: 1, icon: 'fa-play-circle', key: 'start' },
  { id: 2, icon: 'fa-flag-checkered', key: 'end' },
  { id: 3, icon: 'fa-tag', key: 'text' },
  { id: 4, icon: 'fa-file-text', key: 'file' },
  { id: 5, icon: 'fa-search', key: 'webSearch' },
  { id: 6, icon: 'fa-globe', key: 'webCrawl' },
  { id: 7, icon: 'fa-microchip', key: 'inference' },
  { id: 8, icon: 'fa-code-fork', key: 'decision' },
  { id: 9, icon: 'fa-code', key: 'python' },
  { id: 10, icon: 'fa-database', key: 'knowledge' },
  { id: 11, icon: 'fa-table', key: 'structured' },
  { id: 12, icon: 'fa-plug', key: 'mcp' },
  { id: 13, icon: 'fa-sitemap', key: 'subflow' },
  { id: 14, icon: 'fa-repeat', key: 'iteration' },
  { id: 15, icon: 'fa-object-group', key: 'aggregator' },
  { id: 16, icon: 'fa-list', key: 'list' },
  { id: 17, icon: 'fa-file-excel-o', key: 'data' },
  { id: 18, icon: 'fa-android', key: 'agent' }
])

// 学习模块视图列表（图标与学习模块顶部标签一致，均为 fa）
const learningViews = ref([
  { id: 1, icon: 'fa-dashboard', key: 'overview' },
  { id: 2, icon: 'fa-map-o', key: 'map' },
  { id: 3, icon: 'fa-refresh', key: 'review' },
  { id: 4, icon: 'fa-exclamation-circle', key: 'mistakes' },
  { id: 5, icon: 'fa-graduation-cap', key: 'exam' }
])
// 学习核心机制步骤
const learningSteps = ref([1, 2, 3, 4, 5])

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
  { id: 2, icon: '🧑‍✈️', key: 'auto-host' },
  { id: 3, icon: '🗣️', key: 'debate' }
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
    { icon: 'fa-users', key: 'collab' },
    { icon: 'fa-comments', key: 'llm' },
    { icon: 'fa-key', key: 'credentials' },
    { icon: 'fa-link', key: 'fileassoc' },
    { icon: 'fa-ellipsis-h', key: 'other' }
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
  { id: 8, icon: '📊', key: 'gantt' },
  { id: 9, icon: '🗓️', key: 'calendar' },
  { id: 10, icon: '📍', key: 'map' },
  { id: 11, icon: '📝', key: 'table' },
  { id: 12, icon: '🖥️', key: 'presentation' },
  { id: 13, icon: '🎨', key: 'excalidraw' },
  { id: 14, icon: '📐', key: 'drawio' }
])

// 待办管理视图列表
const todoViews = ref([
  { id: 1, icon: '📝', key: 'notes' },
  { id: 2, icon: '🌲', key: 'tree' },
  { id: 3, icon: '🗓️', key: 'month' },
  { id: 4, icon: '📅', key: 'week' }
])

// 待办管理各视图使用要点（steps 为步骤序号列表）
const todoTips = ref([
  { key: 'notes', icon: 'fa-sticky-note-o', steps: [1, 2, 3] },
  { key: 'tree', icon: 'fa-sitemap', steps: [1, 2, 3] },
  { key: 'month', icon: 'fa-map-o', steps: [1, 2, 3] },
  { key: 'week', icon: 'fa-calendar-o', steps: [1, 2, 3, 4] }
])

// AI 对话方案列表（六种：普通 / 知识库 / 工作流 / 智能体 / PTC / 集群）
const aiChatSchemes = ref([
  { id: 1, icon: '💬', key: 'normal' },
  { id: 2, icon: '📚', key: 'retrieval' },
  { id: 3, icon: '🔗', key: 'workflow' },
  { id: 4, icon: '🤖', key: 'agent' },
  { id: 5, icon: '🧩', key: 'code' },
  { id: 6, icon: '👥', key: 'swarm' }
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
      subtitle: '新手友好指南 - 八大核心功能'
    },
    sections: {
      'quick-start': {
        title: '快速开始',
        subtitle: '5分钟体验'
      },
      'ai-chat': {
        title: '智能对话',
        subtitle: 'RAG助手'
      },
      'knowledge': {
        title: '知识管理',
        subtitle: '数字大脑'
      },
      'know-rag': {
        title: '知识处理',
        subtitle: 'RAG引擎'
      },
      'workflow': {
        title: '工作流',
        subtitle: '自动化'
      },
      'data-canvas': {
        title: '数据画布',
        subtitle: '无代码数据建模'
      },
      'settings': {
        title: '设置',
        subtitle: '集中管理'
      },
      'agent-scaffold': {
        title: 'Agent脚手架',
        subtitle: '通用执行框架'
      },
      'browser': {
        title: '浏览器',
        subtitle: '内置网页浏览与 AI 网页操作'
      },
      'todo': {
        title: '待办管理',
        subtitle: '灵感与规划'
      },
      'learning': {
        title: '学习',
        subtitle: '掌握式记忆与复习'
      },
      'credits': {
        title: '设计参考',
        subtitle: '借鉴的开源项目'
      },
      'faq': {
        title: '常见问题',
        subtitle: '新手必读'
      },
      'changelog': {
        title: '更新日志',
        subtitle: '历次功能变更'
      }
    },
    changelog: {
      tip: {
        title: '📝 关于本页：',
        text: '内容随版本一起打包，源文件为仓库根目录的 <code>CHANGELOG.md</code>（英文界面读 <code>CHANGELOG.en.md</code>）；新版本的功能变更会追加在<strong>最上方</strong>，因此维护时只需编辑该文件，无需改动界面。'
      }
    },
    quickStart: {
      overview: 'AI-KM 是一款<strong>本地优先的桌面 AI 知识管理平台</strong>：AI 对话（RAG 知识问答 / 智能体对话）、文档与白板管理、知识处理（切片向量化构建 .kb 知识库）、掌握式学习与间隔复习、可视化工作流、Agent脚手架与多智能体集群协作、待办与灵感管理一应俱全；数据默认保存在本地，支持离线使用。以下 6 步带你快速上手：',
      tags: ['AI 对话', '知识管理', '知识处理', '掌握式学习', '可视化工作流', 'Agent脚手架', '多智能体集群', '待办管理'],
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
        title: '记录待办',
        items: [
          '点击顶部工具栏的 <strong>"+" 号</strong> 按钮快速创建新笔记',
          '在富文本编辑器中输入你的想法、灵感或待办事项',
          '支持 Markdown 语法，可插入图片、链接和代码块',
          '笔记自动保存在本地，支持分类标签和全文搜索'
        ]
      },
      step4: {
        title: '创建任务',
        items: [
          '进入左侧导航栏的 <strong>任务管理</strong> 模块',
          '点击"新建任务"，填写任务标题、描述和截止时间',
          '支持设置优先级（高/中/低）和任务分类标签',
          '完成任务后勾选复选框即可标记完成，支持看板和列表两种视图'
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
          '在 <strong>主页</strong> 输入区把模式下拉切到 <strong>PTC</strong>（程序化工具调用）：描述需求后 AI 会写一段 TypeScript 程序经 run_code 组合调用工具，消息里会展示程序、返回值与程序内调用的工具',
          '需要多智能体协作时，把模式切到 <strong>集群</strong>：勾选多个 Agent 预设作为成员（成员在「设置 → 智能体 → 预设」维护），发送任务后成员依次发言，可 <strong>@成员名</strong> 点名某一位',
          '打开 <strong>Agent脚手架</strong>：它是这里唯一的脚手架（批量智能体运行 / 表格定向推理 / 文件采集 / 链接采集是它的四种预设）；每个实例关联一个 <code>.task</code> 任务文件，可中断续跑、后台继续',
          '<strong>数据画布</strong>（导航栏「数据画布」）是独立的无代码数据建模模块：画布建模 + 表单录入 + 图表看板，内容自动保存到画布任务文件'
        ]
      }
    },
    aiChat: {
      tasks: {
        title: '各模式适配的大致任务',
        normal: {
          items: [
            '日常问答：通识问题、概念解释、头脑风暴。',
            '写作与润色：改写、摘要、翻译、校对。',
            '文件参考：上传文件 / 图片，让 AI 基于内容作答或总结。',
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
          '<strong>② 多种对话模式</strong>：普通 / 知识库 / 工作流 / 智能体 / PTC / 集群 六种入口，任务从“问答”延伸到“执行”“程序化调用”与“多智能体协作”。',
          '<strong>③ RAG 只是其一</strong>：知识库模式先检索你的文档再作答，并可选本体 / 问题增强 / 多跳 / 社区等策略，但并非全部能力。',
          '<strong>④ 工具与智能体</strong>：智能体可按需读写文件、搜索、浏览网页、访问知识库、调用技能与 MCP。',
          '<strong>⑤ 数据本地化</strong>：对话、.kb、.learning、.flow 均存本地，隐私可控、可离线。'
        ]
      },
      schemes: {
        title: '六种对话模式',
        normal: { name: '普通对话', desc: '直接与 AI 交流，支持上传文件/图片作为参考，适合日常提问与写作；选择联网搜索模型（如 DeepSeek）后提问可自动联网并列出来源。' },
        retrieval: { name: '知识库问答', desc: '关联 .kb 知识库，AI 基于你的文档精准回答（RAG），答案下方展示参考片段与相似度；可在输入框上方选择检索策略（相似度 / 文件增强 / 问题增强 / 本体增强 / 多跳 / 社区 / Agentic 等）。' },
        workflow: { name: '工作流对话', desc: '关联 .flow 工作流，输入起始文本触发自动化流程，实时查看各节点执行步骤与日志。' },
        agent: { name: '智能体对话', desc: '在输入框选择「智能体」模式：可点 👤 选 Agent 预设，或以通用智能体对话。AI 自主规划并调用工具（读写文件 / 搜索 / 浏览网页 / 知识库检索 / 技能 / MCP 等）完成复杂任务；输入 $技能名 可直达技能；支持<strong>上传图片</strong>（多模态，需所选模型支持视觉）与文本附件。<strong>执行期间输入框不锁死</strong>：继续输入要求后按 Enter 即作为<strong>引导</strong>投递给它（不打断当前执行，智能体在下一个 step 带上）。' },
        code: { name: 'PTC（程序化工具调用）', desc: '在输入框模式下拉选择 <strong>PTC</strong>：模型不逐个调用工具，而是写一段 TypeScript 程序，经 <code>run_code</code> 组合调用工具并返回结果。消息里以代码块展示程序、并列出执行返回值、console 日志与<strong>程序内实际调用的工具</strong>；适合多步循环、批量处理这类“一次写清”的任务。步数沿用「设置 → 智能体预设 → 通用智能体」的循环轮数。' },
        swarm: { name: '集群对话', desc: '在输入框选择「集群」模式：勾选<strong>多个 Agent 预设</strong>作为成员，一次任务由多成员协作完成（依次响应 / 群主撮合 / 辩论），可用 <code>@成员名</code> 只点名某一位；成员回复与工具调用与智能体模式完全一致；运行中也可输入<strong>引导</strong>（Enter 发送，投递给正在发言的成员）。' }
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
        description: '知识管理模块（knowFile）是一个<strong>多视图桌面文件管理器</strong>，支持以多种形式浏览、编辑和组织你的本地文件。它提供了标签页式文件浏览、多视图切换和全文搜索等能力，帮助你高效管理知识资产。'
      },
      views: {
        title: '视图一览（12 种视图 + 文件专属视图）',
        browse: { name: '浏览', desc: 'Markdown 预览渲染' },
        edit: { name: '源码编辑', desc: 'Markdown 源码编辑器' },
        blockedit: { name: '可视编辑', desc: '块编辑（所见即所得）' },
        mindmap: { name: '思维导图', desc: '思维导图视图' },
        files: { name: '文件', desc: '文件树浏览' },
        kanban: { name: '看板', desc: '看板任务管理' },
        graph: { name: '图谱', desc: '文件关联图谱' },
        gantt: { name: '甘特', desc: '甘特图时间线' },
        calendar: { name: '月历', desc: '日历视图' },
        map: { name: '地图', desc: '地理位置标注' },
        table: { name: '表格', desc: '表格数据视图' },
        presentation: { name: '演示', desc: '演示文稿幻灯片视图' },
        excalidraw: { name: '白板', desc: 'Excalidraw 无限画布绘图（.excalidraw 文件专属）' },
        drawio: { name: '图表', desc: 'draw.io 图表绘图（.drawio / .dio 文件专属）' }
      },
      features: {
        title: '核心功能',
        step1: { title: '📂 文件浏览', desc: '左侧文件树展示目录结构，支持展开/折叠。点击文件在右侧以对应视图打开，支持多标签页同时打开多个文件。' },
        step2: { title: '🔄 多视图切换', desc: '同一个文件可切换不同视图查看：浏览（渲染）、源码编辑、可视编辑（块编辑/所见即所得）、思维导图、演示。你可以在设置中开启/关闭不需要的视图。' },
        step3: { title: '🔍 全文搜索', desc: '顶部搜索框支持按文件名和内容全文搜索，快速定位所需文件。搜索结果可点击直接跳转到文件位置。' },
        step4: { title: '🏷️ 分类管理', desc: '支持标签分类、看板视图管理任务、甘特图跟踪项目进度、图谱展示文件关联关系，满足不同维度的管理需求。' }
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
          desc: '点状态栏的 ⬇ <strong>导出文档</strong> 图标，菜单里有「导出 Markdown」「导出 Word」「导出 PDF」三项。'
        },
        step3: {
          title: '导出 Word 的另存为对话框',
          desc: '选「导出 Word」会弹出<strong>另存为对话框</strong>：<strong>导出样式</strong>可选 公文（GB/T 9704-2012，默认）/ 中文论文 / 英文论文（APA 7）/ <strong>自定义 .docx 模板</strong>，并可<strong>指定保存位置</strong>（默认当前文件所在目录）。数学公式、表格、图片、Mermaid 图会一并导出（公式优先转成 Word 原生可编辑公式）。'
        },
        step4: {
          title: '其他导出入口与默认样式',
          desc: '同一套 Word 导出也用于<strong>主页聊天</strong>（消息区右键 → 导出 → Word）与<strong>集群运行结果面板</strong>；默认模板与自定义样式文件在 <strong>设置 → 通用 → 其他 → Word 导出</strong> 中设置。'
        },
        note: {
          title: '📌 使用提示：',
          text: '附带上下文有<strong>约 12 万字符</strong>上限，超出时会在输入区与已发送气泡中<strong>明确提示已截断</strong>（不会静默丢弃）；PDF 的智能操作使用同一面板，可选附带「当前页文字 / 全文 / 当前页图片」。'
        }
      },
      openMode: {
        title: '🪟 文件打开方式（新窗口 / 窗口内）',
        overview: '在 <strong>设置 → 通用 → 基础 → 文件打开方式</strong> 中选择文件的打开方式，它决定了在知识管理中<strong>双击文件</strong>时的行为与主窗口布局：',
        newWindow: {
          name: '🪟 新窗口打开（默认）',
          desc: '双击文件时在<strong>独立窗口</strong>中打开，主窗口顶部标签栏自动隐藏。每个文件窗口可独立切换「浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示」视图，窗口标题显示「文件名 - 视图」。多个文件可同时在不同窗口中打开，<strong>并排对照</strong>互不影响主窗口。'
        },
        inner: {
          name: '📑 窗口内打开',
          desc: '双击文件时在主窗口<strong>右侧标签页</strong>中打开（原行为），顶部保留标签栏，可快速在多个文件间切换。标签会<strong>持久化保存</strong>，重启应用后自动恢复；视图管理面板显示全部视图（含浏览 / 源码编辑等文件视图）。'
        },
        effect: {
          title: '🔧 对操作的影响',
          items: [
            '<strong>双击打开位置</strong>：新窗口模式 → 独立窗口；窗口内模式 → 主窗口标签页',
            '<strong>标签栏</strong>：新窗口模式隐藏主窗口标签栏（文件树面板顶部改为「添加工作区 / 打开文件 / 搜索 / 创建文件」按钮组）；窗口内模式保留标签栏',
            '<strong>视图选择</strong>：新窗口模式在独立窗口左上角切换视图；窗口内模式用文件树面板的「👁 眼睛」按钮打开视图管理',
            '<strong>标签持久化</strong>：新窗口模式不保存标签（重启后标签栏为空）；窗口内模式重启后恢复上次打开的标签',
            '<strong>多文件对比</strong>：新窗口模式可将多个文件放在不同窗口并排查看；窗口内模式只能在标签间切换'
          ]
        },
        note: {
          title: '📌 使用提示：',
          text: '无论选择哪种模式，以下操作始终不变：右键「软件内打开」、全文搜索点击结果、文件对话框打开的文件始终在主窗口标签页打开；右键「新窗口打开」子菜单（浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示）始终可用；知识库（.kb）文件一律跳转到知识处理（RAG）模块。'
        }
      },
      drawio: {
        title: '📐 draw.io 图表（.drawio / .dio）',
        overview: '知识管理内置 <strong>draw.io 图表编辑器</strong>（draw.io 官方 webapp 随软件打包，<strong>完全离线可用</strong>）：<code>.drawio</code> / <code>.dio</code> 文件（以及内容含 <code>&lt;mxfile&gt;</code> 的 <code>.xml</code>）在<strong>浏览 / 源码编辑 / 可视编辑 / 思维导图 / 演示</strong>任一视图中都会直接打开绘图画布，用来画流程图、架构图、泳道图、ER 图、UML 等，无需另外安装 draw.io 或联网。',
        step1: {
          title: '创建与打开',
          desc: '文件树顶部 <strong>➕ 创建文件</strong> 弹窗中把类型切到 <strong>draw.io</strong>（自动写入空白图表框架），或在文件上右键「新建文件」时选择该类型；双击 <code>.drawio</code> 文件即进入图表视图。'
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
          desc: '点右下角 ✨ <strong>智能操作</strong> 打开右侧 AI 面板，用自然语言描述需求（如「加一个三步审批流程：提交 → 审核 → 归档」）。AI 会先读取当前图表内容，再生成增量片段并<strong>直接在画布上预览</strong>（面板列出「新增 / 调整 / 删除」明细）：点「确认应用」才写入文件，点「取消」原样回退。既可<strong>新增</strong>图形与连线，也能<strong>调整</strong>已有图形的位置 / 尺寸 / 文字 / 颜色 / 层级 / 连线，或按 id <strong>删除</strong>已有单元。'
        },
        step5: {
          title: '两种智能操作模式',
          desc: '输入框左侧的模式下拉：<strong>自动可调</strong>（默认，允许新增 + 调整 + 删除）/ <strong>仅新增</strong>（只添加新图形与连线，绝不改动已有内容，新图形会自动避让到空白区）。协同会话中只有主机能发起智能操作，插入后会向所有成员重新同步图表。'
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
          desc: '进入 <strong>设置 → 通用 → 协作</strong>，打开「<strong>启用协作</strong>」开关，然后点击「<strong>启动协同服务</strong>」。可配置端口（默认 <code>3346</code>）、最大成员数、编辑权限与房间 Token。'
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
          desc: '在 <strong>设置 → 通用 → 共享文件夹</strong> 中启动服务，选择共享目录，配置端口（默认 <code>3347</code>）与 Token，然后复制连接地址（<code>remote-fs://IP:端口?token=…</code>）发给局域网内的其他成员。'
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
        file: { title: '📁 文件视图', desc: '打开文件夹选择知识库根目录，左侧列出所有支持的文件（PDF、Word、Markdown 等），点击文件可在右侧预览内容。顶部状态条提示 PDF/Word 规范化（可一键转换为同名 .md）与文件变更统计；增量检测到「新增 / 修改 / 删除」时，对应文件名标色并带徽标，便于定位具体变更文件。' },
        slice: { title: '✂️ 切片视图', desc: '选择切片策略（默认 / 智能 / 语义），点击切分按钮将文档分割为文本片段，再点向量化按钮生成嵌入。也支持「增量更新」：检测到文件新增 / 修改 / 删除时，自动重切变更文件并同步文件摘要、本体、社区与报告（未变化切片复用向量，幂等）。问题提取请在「问题」标签进行。' },
        ontology: { title: '🕸️ 本体视图', desc: '以 D3.js 力导向图查看“实体 / 关系 / 切片 / 文件 / 问题”的知识图谱，点击节点可高亮联动查看详情与关联切片。提供 <strong>手动连线</strong>（⛓）：进入连线模式后依次点击两个<strong>概念节点</strong>，由大模型自动判定关系类型（仅概念 ↔ 概念；引导与结果提示显示在底部状态栏）。构建 / 清空本体已移至「百科」页。' },
        card: { title: '🧊 百科视图', desc: '以卡片网格管理“实体 = 百科条目”。它是<strong>本体构建入口</strong>：▶ 开始抽取实体（从切片抽取实体 / 关系 / 描述，进度显示在底部状态栏）、↻ 继续（带断点时从断点恢复）、🗑 清空（删除全部实体即卡片及其关系，需确认）。支持搜索、手动添加实体、批量生成描述；点击卡片可查看详情、编辑描述与关联切片。' },
        qa: { title: '💬 问答系统', desc: '聊天面板在顶部下拉选择<strong>检索策略</strong>（内置：相似度 / 文件增强 / 问题增强 / 本体增强 / 多跳 / 社区 / Agentic 等，可在策略配置启停或自定义），并展示每次回答的佐证切片。可调匹配阈值、检索数量、余弦/BM25 混合权重等参数。若知识库尚未切片 / 向量化，直接提问会自动完成准备再检索。' },
        question: { title: '❓ 问题标签页', desc: '问题库入口：▶ 从切片提取「问题 + 答案」对（支持暂停 / 继续 / 停止，进度在底部状态栏）；可手动添加、语义去重 / LLM 合并、Excel 导入导出、生成复合问题；⚖ 独立性评审可让大模型标出不能独立作答的问题（仅会话内，不合适计数显示在底部状态栏）；列表每 40 条下滑加载。' },
        test: { title: '🧪 测试标签页', desc: '自动化评测：测试问题与参考答案来自「问题」页问题库（自动同步）；🔄 读取测试用例 可在设置中修改“测试用例上限”后按新上限重新派生问题；支持批量测试（当前 / 全部策略）、位次分析、导出 Excel。' },
        settings: { title: '⚙️ 设置标签页', desc: '三类配置：知识库配置（.kb 管理）、策略配置（自定义检索策略，见下）、处理配置（切片策略、问题去重、测试用例上限、本体推理描述词与批量大小等）。模型来源统一跟随全局 AI 配置。' }
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
        description: '知识处理全程使用<strong>全局 AI 配置</strong>的模型（设置 → 通用 → 模型中选择的 AI 来源与模型），无需在此单独配置来源。嵌入、对话、处理模型分别默认取该来源的默认嵌入模型与主模型；嵌入模型可在知识库「设置」中调整。支持多种检索算法：余弦相似度、BM25 及混合检索，检索数量可选按数量 / 按匹配率 / 按字符；检索策略可在「策略配置」中自定义（见下）。'
      },
      strategies: {
        title: '自定义检索策略（处理管线）',
        intro: '知识库的问答与测试不再局限于固定模式，可在「知识库 → 设置 → <strong>策略配置</strong>」中自定义检索策略：选择策略类型、编排「处理管线」与「检索管线」的原语组合并调参，问答下拉与自动化测试即按该策略执行。',
        kinds: {
          title: '四种策略类型',
          pipeline: { name: '管线组合', desc: '最灵活：自行编排「处理管线」（构建阶段）与「检索管线」（查询阶段）的原语步骤；每个步骤可选原语、模式（设置基础分 / 乘性提升 / 加权融合 / 取最大）与参数。' },
          mapreduce: { name: '社区全局', desc: 'GraphRAG 风格 Map-Reduce：先按社区生成报告，再并行分片总结、汇总出全局答案，适合“全局概览”类问题。' },
          agentic: { name: '智能路由', desc: '由大模型自主多轮检索：可开关 kb_search / file_search / entity_link / graph_hop / community_search 等检索工具，模型自行决定检索路径。' },
          hybrid: { name: '多路混合', desc: '同时启用多个确定性召回通道（稠密 / 稀疏 / 本体 / 图谱 / 社区），再统一排序（余弦重排或 RRF 排名融合）取 TopK。' }
        },
        pipeline: {
          title: '处理管线 vs 检索管线',
          ingest: '<strong>处理管线（构造管线，构建阶段）</strong>：在切片 / 向量化 / 增量更新时执行，负责构建知识库的增强能力——产出语义向量、本体、社区与报告，供查询阶段消费；已处理的数据自动跳过（幂等）。包含五类处理原语：<strong>问题语义增强</strong>（为问题库补全问题向量，“问题增强”策略的依赖处理管线）、<strong>文件语义增强</strong>（文件 → 摘要向量）、<strong>本体推理</strong>（切片 → 实体/关系）、<strong>社区检测</strong>（实体图 → 社区）、<strong>报告生成</strong>（社区 → 报告）。',
          retrieve: '<strong>检索管线（查询阶段）</strong>：每次提问按编排顺序执行的原语链，例如「稠密召回 → BM25 → 实体链接 → 图谱多跳 → 社区筛选 → 加权融合」，决定知识如何被召回与打分；内置策略缺失的处理原语会提示一键补齐。'
        },
        params: {
          title: '检索参数',
          desc: '每个策略可独立配置召回数量（TopK）、检索模式（按数量 / 按匹配率 / 按字符）、匹配率阈值、字符限制、BM25 开关与权重等；问答与测试即用当前选中策略的参数执行，并支持启用 / 停用 / 恢复默认。'
        }
      }
    },
    workflow: {
      nodes: {
        title: '十八种节点类型',
        start: { name: '开始节点', desc: '工作流的起点' },
        end: { name: '结束节点', desc: '工作流的终点' },
        text: { name: '文本节点', desc: '输入固定文本' },
        file: { name: '本地文件', desc: '读取电脑文件' },
        webSearch: { name: '网络搜索', desc: '上网查资料' },
        webCrawl: { name: '网页抓取', desc: '获取网页内容' },
        inference: { name: '推理节点', desc: '调用AI思考' },
        decision: { name: '决策节点', desc: '分支条件判断' },
        python: { name: 'Python节点', desc: '运行代码' },
        knowledge: { name: '知识库节点', desc: '从知识库找资料' },
        structured: { name: '结构化节点', desc: '表格数据处理' },
        mcp: { name: 'MCP节点', desc: '调用外部工具' },
        subflow: { name: '子工作流节点', desc: '加载并执行外部子工作流' },
        iteration: { name: '迭代节点', desc: '对数组每个元素执行内部流水线，可用 {{节点名.item.字段}} 引用当前元素' },
        aggregator: { name: '变量聚合', desc: '跨迭代收集或合并变量（收集逐次追加，合并扁平化嵌套数组）' },
        list: { name: '列表操作', desc: '对列表执行过滤 / 提取 / 排序 / 去重 / 截取等操作' },
        data: { name: '数据(CSV)', desc: '流式读取 CSV/TSV/TXT/JSON 数据文件，可分批输出配合迭代处理' },
        agent: { name: '智能体节点', desc: '调起通用或预设智能体，自主规划并调用工具完成任务' }
      },
      example: {
        title: '示例：分析新闻文章',
        step1: {
          title: '拖拽三个节点：',
          tags: ['🕸️ 网页抓取', '📚 知识库节点', '🤖 推理节点']
        },
        step2: {
          title: '连接节点：',
          description: '点击节点底部的连接点 → 拖到下一个节点顶部',
          flow: '网页内容 → 知识库检索 → AI分析'
        },
        step3: {
          title: '配置并运行：',
          items: [
            '网页抓取：输入网址',
            '知识库：选择你的知识库',
            '推理节点：输入分析指令',
            '点击"运行所有节点"'
          ]
        }
      }
    },
    settings: {
      overview: {
        title: '设置总览',
        description: '所有应用配置集中在 <strong>设置</strong> 面板，左侧为二级导航：<strong>通用</strong>（基础 / 协作 / 模型 / 凭据 / 关联 / 其他）、<strong>语音</strong>（合成 / 输入）、<strong>工具</strong>（管理 / 搜索 / MCP / 注册表）、<strong>技能</strong>（管理 / 商店）、<strong>智能体</strong>（预设 / 控制台 / 日志）、<strong>帮助</strong>。点左侧项即进入对应面板；其中的「模型」等全局配置对主页、知识处理、语音等模块统一生效。'
      },
      groups: {
        basic: {
          title: '🧭 通用',
          items: {
            view: { name: '基础', desc: '语言 / 主题 / 窗口缩放 / <strong>文件打开方式</strong> / <strong>关闭按钮行为</strong>，以及路径与常用操作。' },
            collab: { name: '协作', desc: '局域网共享、协同编辑与共享文件夹（端口 / 权限 / Token）。' },
            llm: { name: '模型', desc: '全局 AI 来源与模型、嵌入模型，以及<strong>上下文窗口</strong>（见下方专述）。' },
            credentials: { name: '凭据', desc: 'API Key 表格化管理，明文只存主进程，可被模型配置引用。' },
            fileassoc: { name: '关联', desc: '按文件类型设置系统默认打开方式，可一键设置 / 全部取消。' },
            other: { name: '其他', desc: '系统状态、浏览器、Word 导出与离线地图包（MBTiles）。' }
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
            mcp: { name: 'MCP', desc: 'MCP 服务增删启停，预置 <strong>5 个内置服务</strong>（见下方专述）。' },
            toolregistry: { name: '注册表', desc: '只读查看主进程已注册的工具及其白名单状态。' }
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
            presets: { name: '预设', desc: '角色 / 模型 / 系统提示与逐工具能力，对话中点 👤 使用。' },
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
        overview: '每个对话都有自己的<strong>上下文窗口</strong>（模型一次能记住的 token 上限）。主页聊天标题右侧的<strong>圆环</strong>就是当前对话的占用率：悬停显示「已用 / 上限」与判定依据；低于 70% 为主题色，70–90% 变橙，≥90% 变红，提示该新建对话了。',
        step1: {
          title: '已用 token 的口径',
          desc: '优先使用后端返回的<strong>真实 promptTokens</strong>；后端不回传用量时，按与实际请求一致的口径<strong>估算</strong>，并在悬停提示里标注「（估算）」。集群模式不显示圆环（每个成员各有独立上下文，合并数值没有意义）。'
        },
        step2: {
          title: '分母（窗口上限）从哪里来',
          desc: '优先级为：<strong>来源级手填 &gt; 后端真实探测 &gt; 模型名关键字 &gt; 来源默认值 &gt; 128K</strong>。Ollama / LM Studio 会主动探测已加载实例的真实窗口（例如本地 Ollama 手动设成 64K 也能被读到），不可探测的来源按模型名 / 来源默认值估算。'
        },
        step3: {
          title: '「模型」页里的两行只读信息',
          desc: '设置 → 通用 → <strong>模型</strong>。<strong>Ollama 与 LM Studio</strong> 的配置块有一行 <strong>模型加载状态</strong>：网格逐列列出全部模型及其类型（对话 / 视觉 / 嵌入）、是否已加载、<strong>生效上下文</strong>与<strong>模型上限</strong>的对照（Ollama 还会显示 Modelfile 的 num_ctx），并可 <strong>⬇ 加载 / ⏏ 卸载</strong>（Ollama 走 keep_alive，嵌入模型自动改用 /api/embed；LM Studio 走官方 lms 命令）；不限高度、不出滑块，因此这两个来源不再重复显示「上下文窗口」行。其余来源仍有一行只读的 <strong>上下文窗口</strong>显示圆环实际使用的分母；需要重新探测时，点该块底部的 <strong>API 状态</strong> 即可（各来源的刷新按钮已合并到这一处）。<strong>窗口上限覆盖</strong>行仅在你历史上设置过覆盖值时才会出现（届时可 ✕ 清除）。',
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
        overview: '设置 → 工具 → <strong>MCP</strong> 面板中预置了五个<strong>进程内内置服务</strong>（启动 / 进入设置页时自动注入、默认启用并自动连接、<strong>不可删除</strong>）：它们不依赖外部进程，其工具可被通用智能体 / Agent 预设 / 工作流 MCP 节点调用，也可「对外 HTTP 暴露」供 Claude Desktop、Cursor 等其他 MCP 客户端接入（见左侧「内置服务：对外 HTTP 暴露」开关）。',
        browser: {
          name: '内置浏览器 Agent（builtin-browser）',
          desc: '提供<strong>AI 可控制的真实浏览器窗口</strong>（多标签），暴露 browser_navigate / list_tabs / new_tab / switch_tab / close_tab / get_html / extract_text / extract_markdown / screenshot / click / type / scroll 等 browser_* 工具，让 AI 可以上网查资料、点击填表、抓取并整理页面内容；由主进程浏览器 Agent 服务实现，入口见「知识管理」章节的「浏览器操作」。'
        },
        office: {
          name: 'Office 文档读写（builtin-office，Word + Excel）',
          desc: '读写本地 <strong>.docx</strong> 与 <strong>.xlsx</strong>（共 29 个函数，会话式：open 后返回 docId / workbookId）。<strong>Word</strong>：open_document / list_blocks / read_text / <strong>find_text</strong>（查找定位） / <strong>document_info</strong>（字数·大纲·样式表） / export_markdown（转 Markdown） / find_and_replace_text / <strong>replace_paragraph</strong>（整段重写，保样式） / <strong>insert_paragraph</strong> / <strong>insert_table</strong> / <strong>insert_markdown</strong>（Markdown 成段写入）/ <strong>set_paragraph_style</strong>（标题级别·样式） / <strong>delete_block</strong> / save_document（自动 .bak 备份）。<strong>Excel</strong>：open_workbook / list_sheets / read_sheet（区域读取，Markdown/JSON/CSV，可看公式）/ search_cells（定位单元格）/ <strong>query_rows</strong>（多条件筛选·排序·分页）/ <strong>aggregate</strong>（分组求和·均值·计数·去重·极值）/ set_cells（批量写单元格，保留原样式）/ append_rows / add_sheet / rename_sheet / delete_sheet / create_workbook（新建）/ save_workbook / close_workbook。写入均<strong>只改动对应 XML 部件</strong>（样式、公式、图表、图片全部保留），保存前自动生成 <code>.bak</code> 可回滚；.xls / .csv 只能读取查询（写回会提示先另存为 .xlsx）；工具参数在调用前会做<strong>别名归一</strong>（如 query_sheet → sheet、workbook_id → workbookId），漏传必填参数（如 workbookId / docId）会被直接拦住并提示先 open，不再笼统报「会话已关闭」。'
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
          desc: '点关闭只把窗口<strong>收起</strong>到屏幕右下角「托管区」（Windows 通知区域 / macOS 菜单栏），程序与后台任务<strong>不受影响</strong>地继续运行；因为不会中断任务，折叠时<strong>不再弹提醒</strong>，首次折叠会有一个气泡提示。'
        },
        trayMenu: {
          title: '📌 托管区图标可以做什么：',
          hover: '<strong>鼠标悬停</strong>：显示后台任务数与<strong>每一个实例</strong>的进度与预计剩余时间（如「AI-KM · 3 个任务运行中 / · Agent脚手架 1 12/50 剩 3分20秒 / · Agent脚手架 2 3/80 剩 9分10秒」）—— Agent脚手架任务会给出<strong>已完成/总数</strong>与<strong>预计剩余时间</strong>（本段还没跑完任何一项时显示「剩 估算中」）；受系统提示长度限制只列前后几个实例，并在末尾标「…还有 N 个」，完整列表看右键菜单。',
          leftClick: '<strong>单击图标</strong>：窗口在前台时收起、已收起时唤回；<strong>双击</strong>始终唤回窗口。',
          rightClick: '<strong>右键菜单</strong>（系统原生菜单）：显示主窗口 / <strong>设置…</strong>（直达「基础」，方便改回关闭行为）/ 后台任务列表 / 退出 AI-KM。'
        },
        note: {
          title: '📌 使用提示：',
          text: '想彻底退出请用右键菜单的「退出 AI-KM」（或先改回「直接退出软件」再点关闭）；「设置…」会打开设置独立窗口并定位到「基础」。'
        }
      }
    },
    dataCanvas: {
      overview: {
        title: '什么是数据画布？',
        description: '数据画布是<strong>顶层独立模块</strong>（原属 Agent脚手架模块，现已独立到导航栏）：在画布上用节点与连线做<strong>无代码数据建模</strong>——表格 / 参数 / 图表 / 子画布等节点，可缩放、吸附网格、一键重新计算；「数据」页为每列配置<strong>表单录入</strong>方式（文本 / 多行 / 数字 / 日期 / 下拉 / 开关）并批量录入，「主页」页以图表看板展示。画布内容会<strong>自动保存</strong>到关联的 <code>.task</code> 任务文件（变更后约 1.5 秒防抖，工具栏 💾 可立即保存），双击画布 <code>.task</code> 文件会直接打开本模块并加载。'
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
          '在导航栏选择 <strong>数据画布</strong>（可在 设置 → 界面 → 功能开关 中隐藏该按钮）',
          '「画布」页双击空白处或点 + 添加节点（表格 / 参数 / 图表 / 子画布等），拖拽摆位、连线定义数据流向；选中节点后可在右侧属性面板编辑',
          '「数据」页录入数据：按列配置录入方式（或由表格节点从 Excel / Markdown 导入），侧边栏按标题字段快速切换记录',
          '「主页」页查看图表看板：支持顺序排列 / 自定义拖放与布局锁定；画布工具栏可导出 / 导入 <code>.data</code> 数据包'
        ]
      },
      notes: {
        title: '说明',
        items: [
          '画布文件与其它脚手架同为 <code>.task</code> 格式：内容变更自动保存，文件缺失时下次保存会重新询问位置',
          '一个画布任务文件可容纳多个数据模型，随文件一起保存与恢复；导出数据包用于分享或备份',
          '数据画布不再出现在 Agent脚手架 的「新建实例」菜单中；旧版本的画布 <code>.task</code> 文件双击仍会打开本模块'
        ]
      }
    },
    agentScaffold: {
      overview: {
        title: '什么是 Agent脚手架？',
        description: 'Agent脚手架是<strong>通用 Agent 执行框架</strong>（应用内称 Harness）：以<strong>表格驱动</strong>的方式跑批量任务——<strong>面板里唯一的脚手架就是「Agent脚手架」</strong>：原批量智能体运行 / 表格定向推理 / 文件采集表格 / 链接采集表格四种脚手架已并入为它的<strong>四种预设</strong>（旧 <code>.task</code> 文件打开时自动转换）。每个<strong>实例</strong>关联一个 <code>.task</code> 任务文件，可中断续跑、后台继续；需要“写程序调用工具”的 PTC 能力请用<strong>主页的 PTC 模式</strong>。'
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
          desc: '以「批量智能体运行」为骨架演进的<strong>Agent脚手架</strong>：任务页拆为<strong>来源</strong>、<strong>执行方式</strong>与<strong>输出方式</strong>三个维度——来源可选 <strong>表格（导入 xlsx / csv）</strong>、<strong>文件夹（扫描本地文件，逐文件生成任务行）</strong> 或 <strong>文本（每行一条：可粘贴网址 / 文件路径 / 任意文本）</strong>；执行方式可选 <strong>智能体（完整会话，带工具）</strong>（任务指令、并发智能体）或 <strong>纯 LLM 推理（无工具）</strong>；输出方式可选 <strong>单独结果</strong>（智能体→结果列；纯 LLM→逐列写回原表新列）或 <strong>结构化提取</strong>（每行输出 JSON，按字段/主键合并进数据表；智能体与纯 LLM 都可用）——单独结果即「只有一个字段的结构化结果」，两者共用导出列 / 运行信息配置，相互切换不会丢失导出列选择；旧「表格定向推理」任务读取后自动落在「结构化提取」（旧写回值会转成数据表记录）。纯 LLM 的结构化分支另含<strong>任务目标</strong>（支持 {{列名}} 占位符）与<strong>内容获取</strong>（行数据 / 读取字段中的本地文件 / 抓取字段中的网页——抓网页即链接采集，会把页面标题与发现的链接存为行字段并按「链接跟随」策略在深度与页数约束内自动扩展新任务行）。<strong>任务页</strong>无外框无标题，三列排布：左列＝<strong>执行与配置</strong>一张卡片（<strong>操作栏并入卡片顶部</strong>：读取 / 保存 / 另存为 · 重置 / 停止 / 启动；随后就是<strong>预设</strong>下拉），中列＝<strong>输入</strong>，右列＝<strong>输出</strong>（窄窗口直接降为单列——不再有中间的两栏态；三列面板铺满任务页高度，内容超高时在各自面板内滚动——左列配置项随卡片整体上下滚动；输入面板里「数据选择」在上、「任务指令」占满剩余高度）：「预设」下拉（批量智能体运行 / 表格定向推理 / 文件采集表格 / 链接采集表格）可一键套用旧脚手架的配置形态，手动改动后回到「自定义配置」；「读取」还能直接打开旧脚手架的 .task 任务文件并自动转换（含写回值 / 任务行 / 已采集数据）。导入表格或选择文件夹后，输入面板下方会显示<strong>来源路径</strong>（附行数，悬停看全文）；「执行」面板的<strong>详情标题</strong>可选详情表格左列显示哪个字段（不显示 / 一个字段，运行中可随时切换）；「输出」面板的<strong>输出字段</strong>以表格编辑（字段名 + 推理指令 / 说明；结构化提取时另含「必填 / 主键」两列）——逐列写回与结构化提取<strong>共用同一张字段列表</strong>，切换输出方式不用重配；<strong>输入</strong>面板分<strong>任务指令</strong>（原「任务模板 / 任务目标」统一，含 {{列名}} 占位符，每行渲染一次，三种执行方式共用）与<strong>数据选择</strong>（点列名把 {{列名}} 写入 / 移除任务指令，已引用高亮，带全部引用 / 全部移除；结构化提取的「内容获取 / 取值字段 / 抓取设置」也在此）两段。页面按标签页分工：<strong>任务</strong>（配置与启动）、<strong>详情</strong>（每行一个子任务：状态 / 开始结束时间 / 耗时 / 推理步数 / Token（<strong>纯 LLM 推理同样统计行 Token</strong>）/ 错误；<strong>结构化提取按「提取字段」、逐列写回按「目标列」逐列展示</strong>，点行看完整记录（写回模式可在行详情里改目标列结果 JSON）与提取数据；运行中可直接<strong>停止</strong>）、<strong>结果</strong>（预览与导出：结构化模式看提取数据集，否则只读一览全部行；纯 LLM 写回列自动成列；导出预览：结果页直接展示<strong>导出 Excel 会写入的内容</strong>，列在「输出」面板配置（竖向列表逐项开关原表列 / 运行信息（行号 / 任务指令 / 状态 / 时间 / Token…）/ 各轮结果，拖动手柄调整顺序——顺序即导出表的列顺序，点列名即可改名（结果页表头与导出的 Excel 同用此名，改过名的列标出原名），结构化模式下按产生该条数据的任务行合并；「输出方式 / 输出字段 / 导出列」的说明文字改为在标题上悬停查看）、结果页<strong>渐进式加载</strong>（滚动到底自动继续），支持全列关键字搜索、按列筛选与行号跳转高亮，并可<strong>逐条删除</strong>单条结果；重跑结构化提取默认 <strong>替换该行原有结果</strong>（可在「输出 → 重跑结果」改为「保留并合并」）；结果表最左「<strong>任务行</strong>」列点号可直接跳到「详情」对应行；源表改过时点「<strong>同步源表</strong>」重读并按行指纹 / 首列值把结果对回原位（新增 / 已变更 / 已移除都标出来，工具栏「+新增 ~变更 -移除」里点「新增 / 变更」即在下方表格筛选、悬停看列级差异与对位说明）；源表增删 / 改过行后重读表格会按<strong>行指纹</strong>把历史结果对回正确的行，并给出「新增 / 已变更 / 已移除」增量（已变更 = 还是同一行、结果仍留在该行上（源数据改过，建议重跑）；已删行的多余结果会自动删掉（对位不可靠时只标「已移除」，结果页「已移除 N」按钮可只看这些）；结果条数多于任务行数时表下会给出统计，工具栏的「异常 N」按钮可筛出不属于任何任务行的结果（「删除这些」可删掉，「清除」只取消筛选），「同步结果」则按当前任务行重建结果、数量与数据都与任务行一致））；增删位置不可靠时只报行数增减）、<strong>图谱</strong>（链接采集的<strong>爬取轨迹</strong>——节点=页面、边=谁发现谁、给出深度分布；或任意智能体行的<strong>访问路径</strong>——每行一个「智能体」节点（紫），连向它访问过的信源与调用过的 MCP 服务（未调用工具的智能体也显示为单个节点）；工具栏用<strong>彩色圆点图例</strong>展示各类型（单击即筛选显示 / 隐藏），节点上限与视图选择同栏（默认 2000；打开时先给一个较广的初始视角，布局收敛后自动把全部节点框进视口并居中——自己缩放 / 拖动后就不再自动调整了）；不需要时可在「执行与配置」取消勾选 <strong>启用「图谱」标签页</strong>（关闭后不做投影、也不显示该页签）；默认视图会按任务自动选择（有网页行 → 爬取轨迹，否则有过程快照 → 访问路径），无内容时给出说明文案）与<strong>日志</strong>（主日志 + 各线程、级别筛选；清空按钮在日志工具栏右侧）。旧的批量 / 表格推理 / 文件采集 / 链接采集 <code>.task</code> 文件打开时会自动转换为本流水线配置。'
        }
      },
      usage: {
        title: '使用步骤',
        items: [
          '在左侧导航栏选择 <strong>Agent脚手架</strong>',
          '顶部 <strong>实例导航栏</strong> 可同时开多个实例：左端常驻按钮 <strong>打开 / 新建 / 开始 / 暂停 / 保存</strong>（<strong>开始 / 暂停 按当前实例的任务状态显示</strong>：有待处理行才出现「开始」，运行中只显示「暂停」，没活可干时两个都不出现）（打开 = 选择 .task 文件在新实例中打开；新建 = 直接新建一个任务实例（**不预建文件**，首次「保存」时再选 .task 保存位置）；<strong>开始 / 暂停 / 保存只作用于当前标签的任务</strong>（开始 = 运行 / 继续当前任务；暂停 = 暂停当前任务（状态保留）；保存 = 把当前任务写回它的任务文件（尚未关联文件的会先弹出保存对话框选位置），运行中的保存当前快照）；<strong>按住 Ctrl / ⌘ / Alt 点击</strong> 这三个按钮则作用于全部已打开实例；保存与「导出 Excel」的结果（保存中 / 已保存 / 已取消 / 失败）显示在<strong>底部状态栏左侧</strong>，成功与取消不再弹提示框，几秒后自动消失（失败详情悬停可见），一次保存多个实例时汇总成一行；任务的<strong>运行状态显示在状态栏最左侧</strong>（转圈 + 「执行中…」等文字），左列「启动」按钮运行时只变灰、不再显示「运行中…」）——不再有下拉菜单；标签悬停可看文件位置（运行中还会显示进度与预计剩余时间），双击或右键重命名、点 × 关闭（文件保留）；双击 <code>.task</code> 文件会直接打开对应实例（关闭全部实例后会出现<strong>引导页</strong>：「新建任务 / 打开任务」两个推荐按钮；此时实例导航栏会隐藏，因为其中的按钮在这里没作用）',
          '新建实例即「Agent脚手架」（唯一类型）；新建时<strong>不预建任务文件</strong>，首次点「保存」再选 <code>.task</code> 保存位置；在任务页左上「<strong>预设</strong>」下拉选四种形态之一（批量智能体运行 / 表格定向推理 / 文件采集表格 / 链接采集表格），或保持「自定义配置」',
          '任务页左列「执行与配置」的 <strong>随任务文件保留</strong> 可分别勾选是否把 <strong>图谱数据</strong>（行过程快照，图谱与行详情的数据来源）与 <strong>运行日志</strong> 写进任务文件（重开后仍可查看）；<strong>默认两者都不保留</strong>（任务文件更小）',
          '任务页「<strong>轮次</strong>」可对同一批任务行跑多轮：新建轮次保留行数据（状态置回待处理）、可换配置或指令再跑，每轮各存一份配置快照与结果，用下拉切换查看（结果 / 图谱 / 导出都针对当前轮）',
          '「数据选择」里的<strong>前轮结果</strong>芯片（如 <code>{{第1轮.结果}}</code> / <code>{{第1轮.字段}}</code>）可把前几轮产出写进本轮指令（取<strong>同一行</strong>的前轮结果）；「导出列」里再勾选想要的轮次，就能把各轮结果按行<strong>并排成列</strong>对比',
          '轮次区带 <strong>⑂</strong> 的按钮是<strong>链式新轮次</strong>：把本轮结果展开成新一轮的任务行（结构化提取逐条记录成一行），适合先发散再收敛；多轮时可打开「<strong>对比</strong>」页签，把同一批行在各轮的产出并排看（⚠ 不一致、? 缺结果；上方「轮次」芯片可点选显示 / 隐藏该轮，至少保留一轮）；点任意一格的产出即可弹窗用 Markdown 渲染预览（标题显示所属轮次），表格始终列出全部行（只在其它轮出现的行也会列出，该轮无结果显示 —）',
          '点表格行弹出<strong>行详情</strong>，分<strong>任务 / 过程 / 输出</strong>三个页签（页签在左、运行计数（开始 / 结束 / 耗时 / 步数 / Token）在右；切换页签后会保持，连续核对多行不用反复切）：任务 = 占位符替换后真正发出的任务，过程 = 推理步骤与工具调用（与主页对话的工具盒子同款：<strong>默认只显示单行摘要</strong>，点一下展开参数与结果，运行中实时更新），输出 = 提取数据 / 写回列 / 结果文本（运行中<strong>直接流式显示渲染后的正文</strong>，不再显示 Markdown 源码；Markdown 按预览尺寸紧凑排版，不再整段被撑高）；<strong>底部按钮栏</strong>从左到右是页签对应的操作（复制 / 编辑，编辑时变保存 + 取消）→ <strong>状态下拉</strong>（待处理 / 已完成 / 失败 / 跳过，只改状态、结果不动——选「待处理」即待执行，回任务页点启动就会跑它；执行中的行不可改）→ <strong>停止本行</strong>（仅该行执行中显示：取消它的会话或请求，收尾为「跳过」，<strong>其它行与整批不受影响</strong>）→ <strong>重跑本行</strong>（不是执行中时显示：批量运行中→插到队首立即执行，未运行→置待处理并启动）→ 删除，右侧是关闭（按钮与下拉同高；详情表格的「操作」列只显示状态文字，不再放任何按钮）',
          '「<strong>详情</strong>」页的<strong>筛选</strong>按钮打开筛选面板：状态 / 搜索 / 结果 / 行号 / 步数 / 耗时 集中在一处（步数、耗时用 <strong>&lt; ≤ &gt; ≥ =</strong> + 数值；未运行按 0 步 / 0 秒，耗时默认秒且可写 90 / 1.5m / 2m30s），面板内实时显示<strong>命中行数</strong>；命中行可一键<strong>批量标记</strong>为 待处理（= 待执行，下次启动即跑）/ 跳过 / 已完成 / 失败，或直接「重跑命中行」（标记待处理并立即执行）',
          '按 <strong>来源 / 执行方式 / 输出方式</strong> 三个维度补齐配置：来源 = 表格 / 文件夹 / 文本，执行方式 = 智能体 / 纯 LLM，输出方式 = 单独结果 / 结构化提取；再点「启动」开始',
          '任务支持中断后续跑（状态保留），并保存在实例关联的 <code>.task</code> 任务文件中，双击该文件即可恢复',
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
        step3: { title: '选择运行方式与总结', desc: '成员标签右侧的<strong>运行方式</strong>下拉提供三档：全员响应 / 群主撮合 / 辩论；再右侧的<strong>总结</strong>开关决定任务结束后是否由群主汇总（默认关闭）。这些选项随对话保存。' },
        step4: { title: '发送任务 & @点名', desc: '在输入框输入任务并发送：不带 <code>@</code> 时按运行方式让成员参与；输入 <code>@成员名</code> 则<strong>只唤起该成员</strong>单独执行（不总结）。' },
        step5: { title: '查看过程与结果', desc: '成员汇报就是对话里的消息：正文按 Markdown 渲染，<strong>工具调用 / 思考过程以卡片形式内联</strong>（与智能体模式完全一致），可展开查看参数与结果；运行中可 ■ 停止，任务完成后会自动生成对话标题。' }
      },
      modes: {
        title: '运行方式（输入区下拉）',
        'auto-mention': { name: '全员响应', desc: '所有选中成员依次就任务作答；成员也可在回复里 @同事 追加协作。默认方式。' },
        'auto-host': { name: '群主撮合', desc: '全员发言后由群主串场点名撮合：成员即使不写 @ 也能被安排接力回应，随后可选群主总结。' },
        debate: { name: '辩论', desc: '多个成员围绕任务多轮辩论，最后由群主中立总结，适合需要多方对比的决策类问题。' }
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
          '浏览器 Agent 同时是<strong>内置 MCP 服务（builtin-browser）</strong>：智能体通过 browser_* 工具导航、新建 / 切换 / 关闭标签、读取正文（文本 / Markdown / HTML）、点击、输入、滚动与截图，可在「设置 → 工具 → MCP」中开关与查看函数。同页还有 <strong>drawio 内置服务（builtin-drawio）</strong>：智能体用 44 个 drawio_* 工具直接创建、查看、修改、布局与导出本地 .drawio 图表。',
          '知识管理中的 <strong>.html / .htm</strong> 本地网页可用「打开文件」直接交给浏览器打开渲染，AI 还能继续对其操作、提取正文。'
        ]
      }
    },
    todo: {
      overview: {
        title: '什么是待办管理？',
        description: '待办管理是一个<strong>灵感 / 规划 / 待办一体的条目管理器</strong>（笔记与项目一体），数据默认保存在浏览器 <code>localStorage</code>，可随时导入 / 导出备份迁移。支持 <strong>随手记、树状图、月视图、周视图</strong> 四种查看方式。'
      },
      views: {
        title: '四种视图',
        notes: { name: '随手记', desc: '条目卡片列表 + 右侧块编辑器，可置顶 / 隐藏 / 删除' },
        tree: { name: '树状图', desc: '可拖拽排序的层级树，支持添加子项、删除' },
        month: { name: '月视图', desc: '整月日历，把条目拖拽到日期上安排日程' },
        week: { name: '周视图', desc: '单周日历（周日~周六），左右翻周、拖拽排程' }
      },
      tips: {
        title: '各视图使用要点',
        notes: {
          name: '随手记',
          step1: { title: '快速记录', desc: '点工具栏「+」新建，右侧块编辑器直接输入，Ctrl+S 或点保存持久化；标题或正文填写其一即可。' },
          step2: { title: '置顶 / 隐藏', desc: '卡片图钉按钮可置顶，眼睛按钮可隐藏（类似归档）；配合顶部「显示/隐藏筛选」可查看隐藏项或全部。' },
          step3: { title: '搜索与筛选', desc: '顶部搜索框按标题 / 正文全文匹配；分类筛选按状态过滤；默认置顶优先 + 按更新时间排序。' }
        },
        tree: {
          name: '树状图',
          step1: { title: '层级与子项', desc: '节点可添加子项，展开 / 折叠状态自动保存；拖拽节点可调整层级与顺序。' },
          step2: { title: '右键排序', desc: '右键节点可切换排序方式（默认拖拽顺序 / 名称 / 修改时间 / 开始 / 结束 / 状态），再次点击同项切换正倒序。' },
          step3: { title: '跳转编辑', desc: '点击节点在右侧编辑器查看 / 编辑；父级被筛选隐藏时会自动保留可见的后代节点。' }
        },
        month: {
          name: '月视图',
          step1: { title: '翻月', desc: '「回到今天」回到当前月；◀ / ▶ 切换上 / 下月；点击日期可选中该日期。' },
          step2: { title: '拖拽排程', desc: '把项目卡片拖到任意日期：有起止时间的项目整段平移（保持时长），无时间的项目落为单日 9:00~17:00。' },
          step3: { title: '快速新建', desc: '点击日期右上角「+」以该日期为起止时间新建项目；日期旁徽标显示当天项目数量。' }
        },
        week: {
          name: '周视图',
          step1: { title: '翻周', desc: '工具栏「回到今天」返回本周；◀ / ▶ 按钮向前 / 后翻 7 天；标题显示当前周的日期范围与周序号。' },
          step2: { title: '排程拖拽', desc: '项目卡片可直接拖拽到任意一天（与月视图一致）：有起止时间的项目整段平移（保持时长），无时间的项目落为单日 9:00~17:00。' },
          step3: { title: '快速新建', desc: '点击某天的「+」会以该日期为起止时间新建项目；每天顶部显示项目数量徽标，今天列高亮。' },
          step4: { title: '删除', desc: '悬浮项目卡片时右上角出现垃圾桶按钮，点击即可删除（含子项）。' }
        }
      }
    },
    faq: [],
    learning: {
      overview: {
        title: '掌握式学习：记忆与复习',
        desc: '<strong>学习</strong>模块把已保存的知识库（<code>.kb</code>）变成可以“学会”的内容：围绕文件与本体实体做掌握度追踪与间隔复习，配合闪卡练习、错题本与考试，形成“练习 → 复习 → 考试”的闭环。学习记录独立保存在每个知识库旁的 <code>&lt;库名&gt;.learning</code> 中，绝不写入 <code>.kb</code>；知识库更新后旧记录会被标记“过期”保留。'
      },
      viewsTitle: '五大视图',
      view: {
        overview: { name: '总览', desc: '行动中心：下一步建议；整体掌握 / 正确率 / 累计练习在底部状态栏显示；连续学习打卡与近 7/30 天趋势' },
        map: { name: '学习地图', desc: '按文件或按实体查看掌握度（卡片底部横向进度条）；可标记已掌握(跳测)、切换知识类型、清除过期 / 重学' },
        review: { name: '复习', desc: '到期队列（近期答错 / 连续答错优先），一键开始到期复习' },
        mistakes: { name: '错题本', desc: '左列表 + 右详情：参考答案(来源切片)、错因标注(记忆 / 概念 / 步骤 / 粗心)、AI 讲解、重练此题' },
        exam: { name: '考试', desc: '随机或勾选切片生成四类题目(单选 / 多选 / 判断 / 问答)；客观题本地判分、问答题 AI 评分；可把每题计入对应文件学习对象' }
      },
      mech: { title: '核心机制' },
      step1: {
        title: '先有知识库，再选库学习',
        desc: '在「知识处理」切片 / 向量化并保存生成 <code>.kb</code> 后，进入「学习」模块，右上角选择该知识库即可开始。'
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
      subtitle: 'Beginner Friendly Guide - 8 Core Features'
    },
    sections: {
      'quick-start': {
        title: 'Start',
        subtitle: '5 min experience'
      },
      'ai-chat': {
        title: 'Chat',
        subtitle: 'RAG Assistant'
      },
      'knowledge': {
        title: 'Knowledge',
        subtitle: 'Digital Brain'
      },
      'know-rag': {
        title: 'RAG',
        subtitle: 'RAG Engine'
      },
      'workflow': {
        title: 'Workflow',
        subtitle: 'Automation'
      },
      'data-canvas': {
        title: 'Data Canvas',
        subtitle: 'No-code data modeling'
      },
      'settings': {
        title: 'Settings',
        subtitle: 'Central config'
      },
      'agent-scaffold': {
        title: 'Agent Scaffold',
        subtitle: 'Execution framework'
      },
      'browser': {
        title: 'Browser',
        subtitle: 'Built-in browsing with AI web actions'
      },
      'todo': {
        title: 'Todo',
        subtitle: 'Ideas & Plans'
      },
      'learning': {
        title: 'Learning',
        subtitle: 'Mastery & Review'
      },
      'credits': {
        title: 'Credits',
        subtitle: 'Open-source inspirations'
      },
      'faq': {
        title: 'FAQ',
        subtitle: 'Must read'
      },
      'changelog': {
        title: 'Changelog',
        subtitle: 'What changed in each version'
      }
    },
    changelog: {
      tip: {
        title: '📝 About this page:',
        text: 'The content is bundled with each release; the source file is <code>CHANGELOG.md</code> in the repository root (English UI reads <code>CHANGELOG.en.md</code>). New changes are appended at the <strong>top</strong>, so maintainers only need to edit that file — no UI changes required.'
      }
    },
    quickStart: {
      overview: 'AI-KM is a <strong>local-first desktop AI knowledge platform</strong>: AI chat (RAG Q&A / agent chat), document & whiteboard management, knowledge processing (chunk & embed into a .kb), mastery-based learning with spaced review, a visual workflow editor, Agent Scaffold and multi-agent swarm collaboration, plus todo & idea capture — all data stays local by default and works offline. These 6 steps get you started fast:',
      tags: ['AI Chat', 'Knowledge', 'Processing', 'Learning', 'Workflow', 'Agent Scaffold', 'Agent Swarm', 'Todo'],
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
        title: 'Save Todos',
        items: [
          'Click the <strong>"+" button</strong> in the top toolbar to quickly create a new note',
          'Enter your thoughts, ideas, or to-do items in the rich text editor',
          'Supports Markdown syntax, images, links, and code blocks',
          'Notes are saved locally with category tags and full-text search support'
        ]
      },
      step4: {
        title: 'Create Task',
        items: [
          'Go to the <strong>Task Management</strong> module in the left navigation bar',
          'Click "New Task", fill in the title, description, and due date',
          'Supports priority levels (High/Medium/Low) and task category tags',
          'Check the checkbox to mark tasks as complete, supports Kanban and List views'
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
          'Switch the mode dropdown to <strong>PTC</strong> (programmatic tool call) in the Home input bar: describe the task and the AI writes a TypeScript program that calls tools through run_code — the message shows the program, the return value and the tools called inside it',
          'For multi-agent collaboration switch to <strong>Swarm</strong>: tick several Agent presets as members (manage them in Settings → Agent → Presets) and use <strong>@member-name</strong> to call just one',
          'Open <strong>Agent Scaffold</strong>: it is the only scaffold in that module (Batch Agent / Table Reasoning / Collect File / Collect Web are its four presets); every instance links its own <code>.task</code> file, can be paused/resumed and keeps running in the background',
          '<strong>Data Canvas</strong> (nav entry “Data Canvas”) is a standalone no-code data modeling module: canvas modeling + form entry + chart dashboards, auto-saved to its own canvas task file'
        ]
      }
    },
    aiChat: {
      tasks: {
        title: 'What each mode is roughly for',
        normal: {
          items: [
            'Everyday Q&A: general questions, explaining concepts, brainstorming.',
            'Writing & polishing: rewriting, summarizing, translating, proofreading.',
            'File context: upload files/images and ask AI to answer or summarize from them.',
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
          '<strong>② Multiple chat modes</strong>: Normal / Knowledge Base / Workflow / Agent / PTC / Swarm — tasks range from Q&A to execution, programmatic tool calling and multi-agent collaboration.',
          '<strong>③ RAG is just one piece</strong>: Knowledge Base mode first searches your documents, with ontology / question-enhance / multi-hop / community strategies — but that is not all.',
          '<strong>④ Tools & Agents</strong>: Agents can read/write files, search, browse the web, query knowledge bases, invoke skills and MCP.',
          '<strong>⑤ Local data</strong>: chats, .kb, .learning and .flow all live locally — private and offline-ready.'
        ]
      },
      schemes: {
        title: 'Six Chat Modes',
        normal: { name: 'Normal Chat', desc: 'Chat directly with AI; upload files/images as context. Ideal for everyday questions and writing; with a web-search-capable model (e.g. DeepSeek) questions can auto-search the web and list sources.' },
        retrieval: { name: 'Knowledge Base QA', desc: 'Link a .kb knowledge base; AI answers from your documents (RAG), showing reference chunks below. You can pick a retrieval strategy above the input (Similarity / File Enhance / Question Enhance / Ontology Enhance / Multi-hop / Community / Agentic, etc.).' },
        workflow: { name: 'Workflow Chat', desc: 'Link a .flow workflow; enter start text to trigger automation and watch each node\'s steps and logs live.' },
        agent: { name: 'Agent Chat', desc: 'Pick the "Agent" mode in the input bar: choose an Agent preset via 👤, or chat with the general agent. The AI plans autonomously and invokes tools (read/write files, search, browse the web, KB retrieval, skills, MCP, etc.); typing $skill-name triggers a skill directly. <strong>Image uploads</strong> (multimodal, needs a vision-capable model) and text attachments are supported too. The input box stays available <strong>while it runs</strong>: keep typing and press Enter to send <strong>guidance</strong> (the run is not interrupted; the agent picks it up at its next step).' },
        code: { name: 'PTC (Programmatic Tool Call)', desc: 'Pick <strong>PTC</strong> in the input-bar mode dropdown: instead of calling tools one by one, the model writes a TypeScript program that calls tools through <code>run_code</code> and returns the result. The message shows the program as a code block plus the return value, the console logs and the <strong>tools actually called inside the program</strong> — great for multi-step loops and batch processing. Max steps follows the general agent setting (Settings → Agent → Presets).' },
        swarm: { name: 'Swarm Chat', desc: 'Pick the "Swarm" mode in the input bar: tick <strong>multiple Agent presets</strong> as members and let them collaborate on one task (respond in turn / host-led / debate); use <code>@member-name</code> to call a single member. Replies and tool calls render exactly like Agent mode. You can also send <strong>guidance</strong> mid-run (Enter) — it goes to the member currently speaking.' }
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
        description: 'The Knowledge Management module (knowFile) is a <strong>multi-view desktop file manager</strong> that lets you browse, edit, and organize your local files in various formats. It provides tabbed file browsing, multi-view switching, and full-text search capabilities.'
      },
      views: {
        title: 'Views (12 views + file-specific views)',
        browse: { name: 'Browse', desc: 'Markdown rendered preview' },
        edit: { name: 'Source', desc: 'Markdown source editor' },
        blockedit: { name: 'Visual', desc: 'Block editor (WYSIWYG)' },
        mindmap: { name: 'Mind Map', desc: 'Mind map visualization' },
        files: { name: 'Files', desc: 'File tree explorer' },
        kanban: { name: 'Kanban', desc: 'Kanban task management' },
        graph: { name: 'Graph', desc: 'File relationship graph' },
        gantt: { name: 'Gantt', desc: 'Gantt chart timeline' },
        calendar: { name: 'Calendar', desc: 'Monthly calendar view' },
        map: { name: 'Map', desc: 'Geolocation mapping' },
        table: { name: 'Table', desc: 'Tabular data view' },
        presentation: { name: 'Presentation', desc: 'Presentation slides view' },
        excalidraw: { name: 'Whiteboard', desc: 'Excalidraw infinite canvas (.excalidraw files only)' },
        drawio: { name: 'Diagram', desc: 'draw.io diagram editor (.drawio / .dio files only)' }
      },
      features: {
        title: 'Core Features',
        step1: { title: '📂 File Browsing', desc: 'File tree on the left shows directory structure with expand/collapse. Click a file to open it in the corresponding view on the right. Supports multiple tabs for simultaneous file access.' },
        step2: { title: '🔄 Multi-View Switching', desc: 'The same file can be viewed in different modes: Browse (rendered), Edit (source), Mindmap, Presentation. You can enable/disable views in Settings.' },
        step3: { title: '🔍 Full-Text Search', desc: 'The top search bar supports filename and full-text content search to quickly locate files. Search results are clickable to jump directly to the file.' },
        step4: { title: '🏷️ Organization', desc: 'Supports tag categorization, Kanban for task management, Gantt for project timelines, Graph for file relationships, and more to meet different management needs.' }
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
          desc: 'Click the ⬇ <strong>Export document</strong> icon in the status bar: the menu offers “Export Markdown”, “Export Word” and “Export PDF”.'
        },
        step3: {
          title: 'The Word “Save as” dialog',
          desc: 'Choosing “Export Word” opens a <strong>save-as dialog</strong>: pick an <strong>export style</strong> — Official (GB/T 9704-2012, default) / Chinese Paper / English Paper (APA 7) / <strong>Custom .docx template</strong> — and choose the <strong>save location</strong> (defaults to the folder of the current file). Formulas, tables, images and Mermaid diagrams are exported as well (formulas prefer editable native Word equations).'
        },
        step4: {
          title: 'Other export entry points & default style',
          desc: 'The same Word export is also used by <strong>Home chat</strong> (right-click the message area → Export → Word) and the <strong>Swarm run result panel</strong>. The default template and custom style file live under <strong>Settings → General → Other → Word Export</strong>.',
        },
        note: {
          title: '📌 Tip:',
          text: 'Attached context is capped at <strong>about 120,000 characters</strong>; when exceeded, both the input area and the sent bubble <strong>explicitly warn that it was truncated</strong> (nothing is dropped silently). PDF smart actions use the same panel, with attachments for “current page text / full text / current page image”.'
        }
      },
      openMode: {
        title: '🪟 File Open Mode (New Window / Inside)',
        overview: 'In <strong>Settings → General → Basic → File Opening</strong>, choose how files open in Knowledge Management. It controls the <strong>double-click</strong> behavior and the main-window layout:',
        newWindow: {
          name: '🪟 New Window (default)',
          desc: 'Double-clicking a file opens it in a <strong>separate window</strong>; the main-window tab bar is hidden. Each file window can independently switch among "Read / Source / Block Edit / Mind Map / Presentation" views, and the window title shows "filename - view". Multiple files can be opened in different windows at the same time, <strong>side by side</strong>, without affecting the main window.'
        },
        inner: {
          name: '📑 Open Inside',
          desc: 'Double-clicking a file opens it in a <strong>tab</strong> on the right side of the main window (original behavior). The tab bar stays on top for quick switching between files. Tabs are <strong>persisted</strong> and restored automatically after restart; the view manager shows all 12 views (including file views such as Browse / Edit).'
        },
        effect: {
          title: '🔧 Impact on Operations',
          items: [
            '<strong>Double-click location</strong>: New Window mode → separate window; Inside mode → main-window tab',
            '<strong>Tab bar</strong>: New Window mode hides it (the file-tree panel top becomes an "Add Workspace / Open File / Search / Create File" button group); Inside mode keeps it',
            '<strong>View switching</strong>: New Window mode switches views from the top-left of the separate window; Inside mode opens the view manager with the "eye" button in the file-tree panel',
            '<strong>Tab persistence</strong>: New Window mode does not persist tabs (the tab bar stays empty after restart); Inside mode restores the previously opened tabs',
            '<strong>Multi-file comparison</strong>: New Window mode lets you arrange files side by side in separate windows; Inside mode only switches between tabs'
          ]
        },
        note: {
          title: '📌 Tip:',
          text: 'Regardless of the mode, the following stay unchanged: right-click "In App", search-result clicks, and files opened via the file dialog always open as in-window tabs; the right-click "New Window" submenu (Read / Source / Block Edit / Mind Map / Presentation) is always available; knowledge-base (.kb) files always jump to the Knowledge RAG module.'
        }
      },
      drawio: {
        title: '📐 draw.io Diagrams (.drawio / .dio)',
        overview: 'Knowledge Management embeds the <strong>draw.io diagram editor</strong> (the official draw.io webapp is bundled, <strong>fully offline</strong>): <code>.drawio</code> / <code>.dio</code> files (plus <code>.xml</code> whose content contains <code>&lt;mxfile&gt;</code>) open the canvas directly in any of the <strong>Browse / Source / Visual / Mind Map / Presentation</strong> views — for flowcharts, architecture, swimlanes, ER and UML diagrams, with no separate draw.io install and no network.',
        step1: {
          title: 'Create & open',
          desc: 'In the file tree <strong>➕ Create file</strong> dialog switch the type to <strong>draw.io</strong> (a blank diagram skeleton is written), or pick that type when creating a file from the context menu; double-click a <code>.drawio</code> file to open the diagram view.'
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
          desc: 'Click ✨ <strong>Smart actions</strong> at the bottom-right to open the AI panel and describe what you want in natural language (for example “add a three-step approval flow: submit → review → archive”). The AI reads the current diagram, generates an incremental fragment and <strong>previews it right on the canvas</strong> (the panel lists the added / updated / deleted items): click “Apply” to write the file or “Cancel” to restore. It can <strong>add</strong> shapes and edges, <strong>adjust</strong> an existing item’s position / size / label / style / z-order / connections, or <strong>delete</strong> cells by id.'
        },
        step5: {
          title: 'Two smart-action modes',
          desc: 'The mode dropdown next to the input box: <strong>Auto</strong> (default; may add, adjust and delete) / <strong>Add only</strong> (only adds new shapes and edges, never touches existing content, and places new shapes in free space automatically). In a collaboration session only the host can run smart actions, and all members are re-synced afterwards.'
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
          desc: 'Go to <strong>Settings → General → Collaboration</strong>, turn on the "<strong>Enable Collaboration</strong>" switch, then click "<strong>Start Collab Service</strong>". You can configure the port (default <code>3346</code>), max members, edit permission, and room token.'
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
          desc: 'In <strong>Settings → General → Shared Folder</strong>, start the service, choose the shared directory, configure the port (default <code>3347</code>) and token, then copy the link (<code>remote-fs://IP:port?token=…</code>) to other LAN members.'
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
        file: { title: '📁 File View', desc: 'Open a folder as the knowledge base root. Supported files (PDF, Word, Markdown) are listed on the left; click to preview content on the right. The top status bar shows PDF/Word normalization (convert to same-named .md in one click) and file-change stats; when incremental detection finds added / modified / deleted files, the affected filenames are colored with badges.' },
        slice: { title: '✂️ Slice View', desc: 'Choose chunking strategy (Default/Smart/Semantic), click the split button to divide documents into fragments, then click embed to generate vectors. "Incremental Update" detects added / modified / deleted files, re-slices changed files, and syncs summaries, ontology, communities and reports (reusing unchanged slice vectors idempotently). Question extraction lives in the Questions tab.' },
        ontology: { title: '🕸️ Ontology View', desc: 'D3.js force-directed graph of entities / relations / slices / files / questions; click a node to highlight and inspect details & related chunks. <strong>Manual Link</strong> (⛓): enter link mode and click two <strong>concept nodes</strong> in turn — the LLM decides the relation type (concepts only; prompts and results show in the bottom status bar). Building / clearing the ontology now lives in the Encyclopedia tab.' },
        card: { title: '🧊 Encyclopedia View', desc: 'Manage entities (= encyclopedia entries) in a card grid. It is the <strong>ontology build entry</strong>: ▶ Start extract (entities/relations/descriptions; progress shows in the bottom status bar), ↻ Continue (from checkpoint when one exists), 🗑 Clear (removes all entities i.e. cards and their relations, asks for confirmation). Supports search, manual entity add, batch description inference; click a card for details / description editing / associated chunks.' },
        qa: { title: '💬 Q&A System', desc: 'The chat panel lets you pick a <strong>retrieval strategy</strong> from the top dropdown (built-ins include Similarity / File Enhance / Question Enhance / Ontology Enhance / Multi-hop / Community / Agentic, configurable in Strategy Config) and shows the evidence chunks behind each answer. Adjustable match threshold, retrieval count, cosine/BM25 hybrid weights. If the KB is not sliced / vectorized yet, asking a question will automatically prepare it and then retrieve.' },
        question: { title: '❓ Questions Tab', desc: 'Question-bank hub: ▶ extract "question + answer" pairs from slices (pause / resume / stop; progress in the bottom status bar); manual add, semantic dedup / LLM merge, Excel import-export, compound questions. ⚖ Independence review lets the LLM flag questions that cannot be answered independently (session-only; the unsuitable count shows in the bottom status bar). The list lazy-loads 40 per scroll.' },
        test: { title: '🧪 Test Tab', desc: 'Automated evaluation: test questions & reference answers auto-sync from the Questions tab. 🔄 Read Test Cases re-derives questions from the question bank after you change the max limit in settings. Supports batch testing (current / all strategies), rank analysis, and Excel export.' },
        settings: { title: '⚙️ Settings Tab', desc: 'Three groups: KB config (.kb management), Strategy Config (custom retrieval strategies, below), and Processing Config (slice strategy, question dedup, test-case limit, ontology prompts & batch size). Models follow the global AI configuration.' }
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
          agentic: { name: 'Agentic Routing', desc: 'LLM-driven multi-round retrieval: toggle kb_search / file_search / entity_link / graph_hop / community_search tools; the model decides the retrieval path.' },
          hybrid: { name: 'Hybrid', desc: 'Enable multiple deterministic recall channels (dense / sparse / ontology / graph / community) at once, then unify ranking (cosine rerank or RRF fusion) and take TopK.' }
        },
        pipeline: {
          title: 'Ingestion Pipeline vs Retrieval Pipeline',
          ingest: '<strong>Ingestion pipeline (construction, build time)</strong>: runs during slicing / embedding / incremental updates to build the KB\'s enhanced capabilities — producing semantic vectors, ontology, communities, and reports for the query stage; already-processed data is skipped (idempotent). Five kinds of ingestion primitives: <strong>Question Semantic Enhance</strong> (backfill missing question vectors in the question bank; dependency pipeline of the Question strategy), <strong>File Semantic Enhance</strong> (file → summary vector), <strong>Extract Entities</strong> (slice → entities/relations), <strong>Build Communities</strong> (entity graph → communities), <strong>Generate Reports</strong> (community → report).',
          retrieve: '<strong>Retrieval pipeline (query time)</strong>: the primitive chain executed in order on each query, e.g., "dense recall → BM25 → entity link → graph hop → community filter → weighted fuse", deciding how knowledge is recalled and scored; missing required ingestion primitives are prompted for one-click completion.'
        },
        params: {
          title: 'Retrieval Parameters',
          desc: 'Each strategy can independently configure TopK, retrieval mode (By Quantity / By Match Ratio / By Characters), match ratio threshold, character limit, BM25 toggle and weight; QA and tests use the currently selected strategy\'s parameters, with enable / disable / restore-default support.'
        }
      }
    },
    workflow: {
      nodes: {
        title: '18 Node Types',
        start: { name: 'Start', desc: 'Workflow entry point' },
        end: { name: 'End', desc: 'Workflow end point' },
        text: { name: 'Text', desc: 'Static text input' },
        file: { name: 'File', desc: 'Read local files' },
        webSearch: { name: 'Web Search', desc: 'Search online' },
        webCrawl: { name: 'Web Crawl', desc: 'Fetch web content' },
        inference: { name: 'Inference', desc: 'AI reasoning' },
        decision: { name: 'Decision', desc: 'Branch condition routing' },
        python: { name: 'Python', desc: 'Run Python code' },
        knowledge: { name: 'Knowledge', desc: 'Query knowledge base' },
        structured: { name: 'Structured', desc: 'Process tabular data' },
        mcp: { name: 'MCP', desc: 'Call external tools' },
        subflow: { name: 'Sub Workflow', desc: 'Load and execute external sub-workflow' },
        iteration: { name: 'Iteration', desc: 'Runs an inner pipeline for each array element; reference items via {{nodeName.item.field}}' },
        aggregator: { name: 'Aggregator', desc: 'Collect or merge variables across iterations (Collect appends, Merge flattens nested arrays)' },
        list: { name: 'List Ops', desc: 'Filter / extract / sort / unique / slice a list' },
        data: { name: 'Data (CSV)', desc: 'Streaming read of CSV/TSV/TXT/JSON data; can output batches for iteration' },
        agent: { name: 'Agent', desc: 'Invoke a general or preset Agent to plan and call tools autonomously' }
      },
      example: {
        title: 'Example: Analyze News Article',
        step1: {
          title: 'Drag 3 nodes:',
          tags: ['🕸️ Web Crawl', '📚 Knowledge', '🤖 Inference']
        },
        step2: {
          title: 'Connect nodes:',
          description: 'Click bottom connector → Drag to next node top',
          flow: 'Web Content → Knowledge Search → AI Analysis'
        },
        step3: {
          title: 'Configure and run:',
          items: [
            'Web Crawl: Enter URL',
            'Knowledge: Select your knowledge base',
            'Inference: Enter analysis prompt',
            'Click "Run All Nodes"'
          ]
        }
      }
    },
    settings: {
      overview: {
        title: 'Settings Overview',
        description: 'All application configuration lives in the <strong>Settings</strong> panel with a two-level left nav: <strong>General</strong> (Basic / Collaboration / LLM / Credentials / Associations / Other), <strong>Speech</strong> (TTS / ASR), <strong>Tools</strong> (Tools / Search / MCP / Registry), <strong>Skills</strong> (Manage / Store), <strong>Agent</strong> (Presets / Console / Session Log), and <strong>Help</strong>. Click an item on the left to open that panel; global settings (e.g. LLM) apply to Home, Knowledge Processing, Speech, etc.'
      },
      groups: {
        basic: {
          title: '🧭 General',
          items: {
            view: { name: 'Basic', desc: 'Language / theme / window zoom / <strong>file opening</strong> / <strong>close button behavior</strong>, plus paths and common actions.' },
            collab: { name: 'Collaboration', desc: 'LAN sharing, collaborative editing and shared folder (port / permission / token).' },
            llm: { name: 'LLM', desc: 'Global AI providers, models and embedding, plus the <strong>context window</strong> (detailed below).' },
            credentials: { name: 'Credentials', desc: 'API keys managed as a table; plaintext stays in the main process and can be referenced.' },
            fileassoc: { name: 'Associations', desc: 'Set the system default app per file type; one-click set all / clear all.' },
            other: { name: 'Other', desc: 'System status, browser settings, Word export and offline maps (MBTiles).' }
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
            mcp: { name: 'MCP', desc: 'Manage MCP servers; <strong>5 built-in servers</strong> are pre-installed (detailed below).' },
            toolregistry: { name: 'Registry', desc: 'Read-only view of the registered tools and their whitelist state.' }
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
            presets: { name: 'Presets', desc: 'Role / model / system prompt and per-tool capabilities; pick with 👤 in chat.' },
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
        overview: 'Every conversation has its own <strong>context window</strong> (the token budget the model can remember at once). The <strong>ring</strong> next to the chat title on Home shows the current usage: hover it to see “used / limit” and how the limit was determined. Below 70% it uses the theme colour, 70–90% turns orange and ≥90% turns red — a hint to start a new chat.',
        step1: {
          title: 'How “used” tokens are measured',
          desc: 'The <strong>real promptTokens</strong> returned by the backend are used when available; otherwise usage is <strong>estimated</strong> with the same counting rules as the actual request and the tooltip says “(estimated)”. Swarm mode shows no ring (each member has its own context, so a merged number would be meaningless).'
        },
        step2: {
          title: 'Where the denominator comes from',
          desc: 'Priority: <strong>manual per-provider value &gt; real backend probe &gt; model-name keyword &gt; provider default &gt; 128K</strong>. Ollama / LM Studio actively probe the real window of the loaded instance (for example a local Ollama manually set to 64K is detected); providers that cannot be probed fall back to the model-name / provider default estimation.'
        },
        step3: {
          title: 'The two read-only rows under “LLM”',
          desc: 'In Settings → General → <strong>LLM</strong>, the <strong>Ollama and LM Studio</strong> blocks have a <strong>Loaded Models</strong> row: a grid listing every model with its type (chat / vision / embedding), loaded state, and an <strong>effective-context vs model-max</strong> comparison (Ollama also shows the Modelfile num_ctx), plus <strong>⬇ load / ⏏ unload</strong> buttons (Ollama via keep_alive, falling back to /api/embed for embedding models; LM Studio via the official lms CLI); it grows freely with no scrollbar, so these two sources no longer duplicate a “Context window” row. Other providers keep a read-only <strong>Context window</strong> row showing the denominator the ring actually uses; to re-probe, click <strong>API Status</strong> at the bottom of that block (per-row refresh buttons were merged into it). The <strong>Window override</strong> row appears only when you have a historical override set (then you can ✕ clear it).'
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
        overview: 'Under Settings → Tools → <strong>MCP</strong>, five <strong>in-process built-in servers</strong> are pre-created (auto-injected at startup / when opening the page, enabled & auto-connected by default, <strong>cannot be deleted</strong>): they need no external process, their tools can be called by the general agent / Agent presets / workflow MCP nodes, and each can be “externally exposed over HTTP” for other MCP clients (Claude Desktop, Cursor, etc.) via the “External HTTP” toggle on the left.',
        browser: {
          name: 'Built-in Browser Agent (builtin-browser)',
          desc: 'Provides an <strong>AI-controllable real browser window</strong> (multi-tab), exposing browser_* tools — browser_navigate / list_tabs / new_tab / switch_tab / close_tab / get_html / extract_text / extract_markdown / screenshot / click / type / scroll — so AI can research online, click & fill forms, and harvest page content; implemented by the main-process browser agent service (entry: see Browser Operation in the Knowledge chapter).'
        },
        office: {
          name: 'Office Documents (builtin-office, Word + Excel)',
          desc: 'Reads & writes local <strong>.docx</strong> and <strong>.xlsx</strong> files (29 tools, session-based: open returns a docId / workbookId). <strong>Word</strong>: open_document / list_blocks / read_text / <strong>find_text</strong> (locate) / <strong>document_info</strong> (word count · outline · style list) / export_markdown / find_and_replace_text / <strong>replace_paragraph</strong> (rewrite a block, style kept) / <strong>insert_paragraph</strong> / <strong>insert_table</strong> / <strong>insert_markdown</strong> / <strong>set_paragraph_style</strong> (heading level or style) / <strong>delete_block</strong> / save_document (auto <code>.bak</code> backup). <strong>Excel</strong>: open_workbook / list_sheets / read_sheet (range as Markdown/JSON/CSV, formulas optional) / search_cells / <strong>query_rows</strong> (multi-condition filter · sort · paging) / <strong>aggregate</strong> (grouped sum / avg / count / distinct / min / max) / set_cells (batch write, existing styles kept) / append_rows / add_sheet / rename_sheet / delete_sheet / create_workbook / save_workbook / close_workbook. Writes only touch the affected XML parts (styles, formulas, charts and images are preserved) and always back up to <code>.bak</code> first; .xls / .csv are read-only (writing tells the model to save as .xlsx first). Tool arguments are alias-normalized (e.g. query_sheet → sheet, workbook_id → workbookId), and missing required arguments such as workbookId / docId are reported up front with an “open first” hint instead of a vague “session closed” error.'
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
          desc: 'Closing only <strong>hides</strong> the window into the notification area (Windows) or menu bar (macOS); the app and its background tasks <strong>keep running</strong>. Because nothing is interrupted, no warning is shown and a balloon hint appears the first time.'
        },
        trayMenu: {
          title: '📌 What the tray icon offers:',
          hover: '<strong>Hover</strong>: the number of running tasks and each task’s progress (e.g. “AI-KM · 3 tasks running / · Agent Scaffold 1 12/50 · 3m20s left / · Agent Scaffold 2 3/80 · 9m10s left”).',
          leftClick: '<strong>Left click</strong>: hide the window when it is in front, bring it back when hidden; <strong>double click</strong> always brings it back.',
          rightClick: '<strong>Right-click menu</strong> (native system menu): Show Main Window / <strong>Settings…</strong> (opens Basic, where this option lives) / running task list / Quit AI-KM.'
        },
        note: {
          title: '📌 Tip:',
          text: 'To quit completely, use “Quit AI-KM” in the tray menu (or switch back to “Quit directly” and close the window). “Settings…” opens the settings window on the Basic page.'
        }
      }
    },
    dataCanvas: {
      overview: {
        title: 'What is Data Canvas?',
        description: 'Data Canvas is a <strong>standalone top-level module</strong> (formerly part of the Agent Scaffold module, now its own nav entry): build <strong>no-code data models</strong> with nodes and links — table / parameter / chart / sub-canvas nodes with zoom, grid snap and one-click recompute; configure per-column <strong>form entry</strong> types (text / textarea / number / date / select / boolean) on the Data tab, and view charts on the Dashboard tab. Changes are <strong>auto-saved</strong> to the linked <code>.task</code> file (debounced ~1.5s; 💾 saves immediately), and double-clicking a canvas <code>.task</code> file opens this module directly.'
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
          'Select <strong>Data Canvas</strong> from the navigation bar (hide it via Settings → Interface → Feature Switches)',
          'On the <strong>Canvas</strong> tab, double-click empty space or press + to add nodes (table / parameter / chart / sub-canvas…), drag to arrange and link them to define data flow',
          'Enter data on the <strong>Data</strong> tab: set an input type per column (or import tables from Excel / Markdown); the sidebar switches records by title field',
          'View charts on the <strong>Dashboard</strong> tab (flow layout / free drag, layout lock); the canvas toolbar exports / imports a <code>.data</code> package'
        ]
      },
      notes: {
        title: 'Notes',
        items: [
          'Canvas files use the same <code>.task</code> format as other scaffolds: changes auto-save; if the file goes missing you will be asked for a new location on the next save',
          'One canvas task file can hold several data models, saved and restored together with the file; the exported package is for sharing or backup',
          'Data Canvas no longer appears in the Agent Scaffold “New instance” menu; old canvas <code>.task</code> files still open this module on double-click'
        ]
      }
    },
    agentScaffold: {
      overview: {
        title: 'What is the Agent Scaffold?',
        description: 'The <strong>Agent Scaffold</strong> is a <strong>universal Agent execution framework</strong> (the Harness): it runs table-driven batch work — and it is the <strong>only scaffold</strong> left, the former Batch Agent / Table Reasoning / Collect File / Collect Web scaffolds now being its <strong>four presets</strong> (legacy <code>.task</code> files convert automatically when opened). Each <strong>instance</strong> links its own <code>.task</code> file and can be paused, resumed, or left running in the background; for programmatic tool calling use the <strong>PTC mode on the Home page</strong>.'
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
          desc: 'The <strong>Agent scaffold</strong>, evolved from Batch Agent. The task page splits into <strong>Source</strong>, <strong>Execution</strong> and <strong>Output</strong>: the source is a <strong>Table (import xlsx / csv)</strong>, a <strong>Folder (scan local files, one task row per file)</strong>, or <strong>Text (one entry per line: URLs, file paths or plain text)</strong>; execution is <strong>Agent (full session, with tools)</strong> — task instruction, concurrent agents — or <strong>Pure LLM (no tools)</strong>; output is <strong>Single result</strong> (agent → result column; pure LLM → write back to source-table columns) or <strong>Structured extraction</strong> (JSON per row merged into the data table by field / primary key — available for both Agent and Pure LLM); a single result is just the “one field” form of a structured result, and both share the export columns / runtime info settings, so switching never loses that selection; legacy “Table Reasoning” files open as Structured extraction (old write-back values become data-table records). The pure-LLM structured branch adds a <strong>Goal</strong> (supports {{column}} placeholders) and <strong>Content</strong> (row data / local file in a field / web page in a field — fetching is link crawling: page titles and discovered links are stored as row fields and followed into new rows by the follow policy Within depth/page caps). The <strong>Task page</strong> is frameless and title-free, laid out in three columns: left = one <strong>Run &amp; Settings</strong> card with the <strong>action bar merged at its top</strong> (Load / Save / Save as · Reset / Stop / Start, then the <strong>preset</strong> dropdown), middle = <strong>Input</strong> (Data selection on top, the Task instruction filling the rest), right = <strong>Output</strong> (narrow windows go straight to a single column — there is no in-between two-column state; all three panels fill the task page height and scroll inside when content is taller — the left Run &amp; Settings card scrolls as a whole) — the preset dropdown (Batch Agent / Table Reasoning / Collect Files / Collect Web) applies the configuration shape of a legacy scaffold in one click (any manual change switches it back to “Custom”), and <strong>Load</strong> can even open legacy .task files, converting them automatically (write-back values, task rows and collected data included). The imported table or scanned folder <strong>path</strong> appears under the Input panel (with the row count; hover for the full path); <strong>Row title</strong> under Run picks which field the details table shows at its left (none or one field, switchable while running); <strong>Output fields</strong> are edited as a full-width table (field name + inference instruction / description; structured extraction adds Required / PK columns) — column-by-column write-back and structured extraction <strong>share the same field list</strong>, so switching the output mode needs no re-configuring; the <strong>Input</strong> panel has two segments — <strong>Task instruction</strong> (the old template / goal unified; {{column}} placeholders rendered once per row, shared by all three execution modes) and <strong>Data selection</strong> (click a column to write / remove its {{column}} placeholder in the instruction; referenced columns are highlighted, with All / None; content fetching, value field and crawl settings live here too). The page splits into tabs: <strong>Task</strong> (setup and start), <strong>Details</strong> (one row per sub-task: status / start &amp; finish time / duration / reasoning steps / tokens (<strong>pure LLM inference counts per-row tokens too</strong>) / error; in structured mode the extracted fields, and in write-back mode the target columns, become the result columns — click a row for the full record (write-back results are editable as JSON in the row dialog) and extracted data; the batch can be <strong>stopped</strong> right from this tab), <strong>Results</strong> (preview &amp; export: the page shows exactly what “Export Excel” writes — the columns are configured under Output (a vertical list where you switch each source column, runtime info item such as row # / instruction / status / times / tokens, and each round’s result on or off and drag the handle to reorder them — that order is the export column order, and you can rename any column by clicking its name (used by the Results tab and the exported Excel; a renamed column still shows its original name); merged per task row in structured mode; the explanatory text of Output mode / Output fields / Export columns now lives in the hover title), results load <strong>progressively</strong> (scrolling to the bottom keeps loading), with full-text search, filtering by column and row-number jump highlighting, and any single result can be <strong>deleted</strong> individually; results are separate from task rows and rerunning structured extraction <strong>replaces that row’s previous records</strong> by default (switch to keep &amp; merge under Output → Rerun results); the leftmost <strong>Task row</strong> column links each result back to its task row; when the source table changes, “<strong>Sync source</strong>” re-reads it and re-attaches results by fingerprint / first value (new / changed / removed are all marked — click “new” / “changed” in the “+new ~changed -removed” toolbar summary to filter the table below (hover for column-level differences and the matching notes)) (click to open it in the Details tab), and when the source table changes (rows added / removed / edited) a re-import re-attaches results by <strong>row fingerprint</strong> and reports a new / changed / removed delta (only the row-count difference is reported when the positions cannot be determined reliably; changed rows keep their results on the same row (source data edited — rerun when you like); surplus results of deleted rows are deleted automatically (when the match looks unreliable they are only marked “removed” — the “Removed N” button on the Results tab filters down to them); when the Results count exceeds the task-row count, the line under the table breaks it down and the “Orphan N” button filters out results that belong to no task row (“Delete these” removes them; “Clear” only cancels the filter); “Sync results” rebuilds the results from the current task rows so the count and the data line up))), <strong>Graph</strong> (the crawl trajectory — nodes = pages, edges = who discovered whom, with a depth distribution — or the access path of any agent row — one “agent” node per row (purple) with edges to the sources it visited and the MCP services it called (a row that called no tool still shows as a single node); the toolbar shows a <strong>coloured-dot legend</strong> (click a dot to filter that type in/out) next to the view picker and node cap (default 2000; the graph opens with a wider initial view and, once the layout settles, is auto-framed and centred to include every node — manual zoom/pan turns that off); untick <strong>Enable graph tab</strong> under Run &amp; Settings to skip the projection and hide the tab entirely; the view is picked automatically for the task (web rows → crawl trajectory, otherwise process snapshots → access path), with an explanatory empty state) and <strong>Logs</strong> (main + per-worker, level filter; the clear button sits at the right of the log toolbar). Legacy batch / table-reasoning / collect-file / collect-web <code>.task</code> files open into this pipeline and convert automatically.'
        }
      },
      usage: {
        title: 'How to Use',
        items: [
          'Select <strong>Agent Scaffold</strong> from the left navigation',
          'Use the <strong>instance bar</strong> at the top to open several instances at once: five persistent buttons on its left — <strong>Open / New / Start / Pause / Save</strong> (<strong>Start / Pause appear according to that instance’s task state</strong>: Start shows only when it has pending rows, Pause only while it is running, and neither shows when there is nothing to do) (Open picks a .task file for a new instance; New creates an instance right away — no file is created yet, so the first Save asks where to put its <code>.task</code>; <strong>Start / Pause / Save act on the current tab’s task only</strong> (Start runs/resumes it; Pause pauses it keeping its state; Save writes it back to its task file, asking for a location if it has none yet, and saving the current snapshot while running); <strong>hold Ctrl / ⌘ / Alt</strong> while clicking those three to apply to every opened instance; the result of Save and of “Export Excel” (saving / saved / canceled / failed) is shown in the <strong>bottom-left status bar</strong> — success and cancel no longer pop up a message, it clears itself after a few seconds, hover for the failure detail, and saving several instances at once is summarized into one line). No dropdown menu anymore. Hover a tab for the file path (and, while running, the progress and estimated time left), double-click or right-click to rename, click × to close (the file is kept). Double-clicking a <code>.task</code> file opens its instance directly (after closing every instance a <strong>guide page</strong> appears with New task / Open task shortcuts, and the instance bar is hidden since its buttons do nothing there)',
          'A new instance is always the <strong>Agent Scaffold</strong> (the only type); no task file is created up front — the first Save asks where to put it; pick one of the four presets on the task page (Batch Agent / Table Reasoning / Collect File / Collect Web), or keep “Custom”',
          '<strong>Keep in file</strong> (Run &amp; Settings) lets you tick <strong>Graph data</strong> (per-row process snapshots that the graph and row details are built from) and/or <strong>Run logs</strong> so they are written into the task file (still viewable after reopening); both are <strong>off by default</strong> to keep the file small',
          '<strong>Rounds</strong> on the task page let one batch of rows run several times: a new round keeps the rows (status back to pending) and the current config snapshot, so you can change settings / instruction and run again — switch rounds from the dropdown (results / graph / export always follow the active round)',
          '<strong>Previous rounds</strong> chips under Data selection (e.g. <code>{{Round 1.result}}</code> / <code>{{Round 1.field}}</code>) inject an earlier round’s output for the <strong>same row</strong> into this round’s instruction; tick the rounds you want in Export columns to place their results <strong>side by side</strong> for comparison',
          'The <strong>⑂</strong> button next to the rounds is a <strong>chained round</strong>: it expands this round’s results into the next round’s task rows (structured records become one row each) — good for expand-then-refine; with two or more rounds the <strong>Compare</strong> tab shows the same rows side by side (⚠ differ, ? missing result; the Rounds chips above show / hide a round, at least one is always kept); click any output cell to preview it rendered as Markdown in a popup (titled with its round), and the table always lists every row — including rows that exist only in another round, shown as — where a round has no result',
          'Clicking a table row opens the <strong>row detail</strong> in three tabs — <strong>Task / Process / Output</strong> (tabs on the left, the run counters — start / end / duration / steps / tokens — on the right; the tab you pick is kept when you open other rows, so checking many rows for the same kind of info needs no re-clicking): Task = the prompt actually sent after substitution, Process = reasoning steps and tool calls (same tool box as the home chat: <strong>a single-line summary by default</strong>, click to expand arguments and result; live while running), Output = extracted data / written-back columns / result text (while running it <strong>streams the rendered text</strong> instead of the Markdown source; Markdown is laid out compactly for the preview size instead of being stretched out); the <strong>bottom button bar</strong> holds, left to right, the tab action (Copy / Edit — Save + Cancel while editing) → <strong>status dropdown</strong> (Pending / Completed / Failed / Skipped — status only, results are kept; “Pending” = to-run, press Start on the Task tab to run it; running rows cannot be changed) → <strong>Stop this row</strong> (shown while that row is running: its session/request is cancelled and the row is marked “Skipped”; <strong>other rows and the batch keep running</strong>) → <strong>Rerun this row</strong> (shown whenever it is not running: while the batch runs it jumps the queue, otherwise it is marked pending and started right away) → Delete, with Close on the right (buttons and the dropdown share the same height; the Operations column of the table shows plain status text only, no buttons',
          'The <strong>Filter</strong> button on the Details tab opens one panel with every condition — status / search / result / row range / steps / took (steps and duration take <strong>&lt; ≤ &gt; ≥ =</strong> plus a value; never-run rows count as 0 steps / 0 seconds, durations are seconds by default but accept 90 / 1.5m / 2m30s) — and it shows how many rows <strong>match</strong> live; the matched rows can be <strong>marked in bulk</strong> as Pending (= queued for the next Start) / Skipped / Completed / Failed, or rerun right away with “Rerun matched” (mark pending + run)',
          'Configure the three dimensions — <strong>Source</strong> (table / folder / text), <strong>Execution</strong> (agent / pure LLM) and <strong>Output</strong> (single result / structured extraction) — then click Start',
          'Click the run / execute button on the panel — runs can be stopped and resumed later (progress is preserved), and everything is saved to the linked <code>.task</code> file',
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
        step3: { title: 'Choose run mode & summary', desc: 'Next to the member chip, the <strong>run mode</strong> dropdown offers three options: All respond / Host-led / Debate. The <strong>Summary</strong> toggle decides whether the host wraps up at the end (off by default). Both are saved with the conversation.' },
        step4: { title: 'Send a Task & Collaborate', desc: 'Type a task at the bottom and send (typing <code>@member-name</code> pops up candidates and calls that member directly). Without @, members speak in turn according to the mode; members can <code>@colleague</code> in replies to pull others in, or spawn a <strong>generic subagent</strong>. Generic / custom members automatically carry enabled global MCP services plus read/write, search, code and skill capabilities.' },
        step5: { title: 'Watch results', desc: 'Member replies are ordinary messages in the conversation: Markdown body with <strong>inline tool-call / thinking cards</strong> (identical to Agent mode) that expand to show args and results. ■ stops a running task, and a chat title is generated automatically when the task finishes.' }
      },
      modes: {
        title: 'Run Modes (input bar dropdown)',
        'auto-mention': { name: 'All respond', desc: 'Every selected member answers the task in turn; members may also @colleagues in their reply. Default.' },
        'auto-host': { name: 'Host-led', desc: 'After everyone speaks, the host names members to follow up — collaboration works even without @. Optional summary afterwards.' },
        debate: { name: 'Debate', desc: 'Members debate the task over rounds, then the host gives a neutral summary. Best for comparing options.' }
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
          'The Browser Agent is also a <strong>built-in MCP server (builtin-browser)</strong>: agents drive it via browser_* tools (navigate, new / switch / close tabs, read text / Markdown / HTML, click, type, scroll, screenshot). Manage it under Settings → Tools → MCP. The <strong>drawio (builtin-drawio)</strong> built-in server likewise lets agents create, inspect, edit, lay out and export local .drawio diagrams through 44 drawio_* tools.',
          'Local <strong>.html / .htm</strong> pages in Knowledge Management can be sent straight to the browser with “Open File”, and AI can keep operating or extracting them.'
        ]
      }
    },
    todo: {
      overview: {
        title: 'What is Todo Management?',
        description: 'Todo Management is an <strong>all-in-one item manager for ideas / plans / todos</strong> (notes and projects unified). Data is stored in the browser <code>localStorage</code> and can be imported / exported anytime. Four views are provided: <strong>Notes, Tree, Month, and Week</strong>.'
      },
      views: {
        title: 'Four Views',
        notes: { name: 'Notes', desc: 'Card list + block editor, supports pin / hide / delete' },
        tree: { name: 'Tree', desc: 'Draggable hierarchical tree with child items' },
        month: { name: 'Month', desc: 'Full-month calendar, drag items onto dates to schedule' },
        week: { name: 'Week', desc: 'Single-week calendar (Sun–Sat), flip weeks and drag to schedule' }
      },
      tips: {
        title: 'Usage Tips for Each View',
        notes: {
          name: 'Notes',
          step1: { title: 'Quick Capture', desc: 'Click the toolbar "+" to create, type in the block editor, and press Ctrl+S or Save to persist; either a title or content is enough.' },
          step2: { title: 'Pin / Hide', desc: 'The pin button on a card pins it; the eye button hides it (like archiving); use the "Show / Hide" filter to view hidden or all items.' },
          step3: { title: 'Search & Filter', desc: 'The top search box matches title / content; the category filter filters by status; sorting defaults to pinned first, then by update time.' }
        },
        tree: {
          name: 'Tree',
          step1: { title: 'Hierarchy & Children', desc: 'Add child items to nodes; expand / collapse state is saved automatically; drag nodes to adjust hierarchy and order.' },
          step2: { title: 'Right-click Sort', desc: 'Right-click a node to switch sort mode (default drag order / name / updated / start / end / status); click the same item again to toggle ascending / descending.' },
          step3: { title: 'Jump & Edit', desc: 'Click a node to view / edit it in the right editor; hidden ancestors keep their visible descendants.' }
        },
        month: {
          name: 'Month',
          step1: { title: 'Navigate Months', desc: '"Back to today" returns to the current month; ◀ / ▶ switch months; click a date to select it.' },
          step2: { title: 'Drag to Schedule', desc: 'Drag item cards onto any date: items with start/end times shift the whole span (keeping duration); items without times drop as a single day 9:00–17:00.' },
          step3: { title: 'Quick Create', desc: 'Click the "+" at the top-right of a date to create an item on that date; the badge beside the date shows the item count.' }
        },
        week: {
          name: 'Week',
          step1: { title: 'Navigate Weeks', desc: 'Toolbar "Back to today" returns to the current week; ◀ / ▶ buttons go back / forward 7 days; the title shows the date range and week number of the current week.' },
          step2: { title: 'Drag to Schedule', desc: 'Drag item cards onto any day (same as month view): items with start/end times shift the whole span (keeping duration); items without times drop as a single day 9:00–17:00.' },
          step3: { title: 'Quick Create', desc: 'Click the "+" on a day to create an item on that date; each day shows an item-count badge and today is highlighted.' },
          step4: { title: 'Delete', desc: 'Hover an item card to reveal a trash button at the top-right; click to delete (including children).' }
        }
      }
    },
    faq: [],
    learning: {
      overview: {
        title: 'Mastery Learning: Remember & Review',
        desc: 'The <strong>Learning</strong> module turns saved knowledge bases (<code>.kb</code>) into content you can “master”: mastery tracking and spaced repetition over files and ontology entities, plus flashcards, a mistake book and exams — closing the practice → review → exam loop. Learning records live in a separate <code>&lt;name&gt;.learning</code> next to each KB and are never written into <code>.kb</code>; after a KB update old records are marked “stale” and kept.'
      },
      viewsTitle: 'Five views',
      view: {
        overview: { name: 'Overview', desc: 'Action center: next-step suggestions; overall mastery / accuracy / total practice in the bottom status bar; streak & 7/30-day trend' },
        map: { name: 'Map', desc: 'Mastery per file or entity (horizontal progress bar at card bottom); claim mastered (test-out), switch knowledge type, clear stale or relearn' },
        review: { name: 'Review', desc: 'Due queue (recent / consecutive misses first) with one-click due review' },
        mistakes: { name: 'Mistakes', desc: 'List on the left, detail on the right: reference (source slice), reason tagging (memory / concept / procedure / careless), AI explain, retry' },
        exam: { name: 'Exam', desc: 'Random or selected-slice questions (single / multi / true-false / essay); objective graded locally, essays graded by AI; optionally feed each answer into its file learning object' }
      },
      mech: { title: 'Core mechanics' },
      step1: {
        title: 'Build a KB first, then study',
        desc: 'After slicing / vectorizing and saving a <code>.kb</code> in Knowledge Processing, open Learning and pick that KB at the top-right.'
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