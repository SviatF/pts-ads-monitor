import Link from "next/link";
import { getPerformanceDashboardData, healthForAlerts } from "@/lib/performance-dashboard";

export const dynamic = "force-dynamic";

function age(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  const hours = Math.max(0, Math.floor(ms / 3600000));
  if (hours < 1) return "<1 год";
  if (hours < 24) return `${hours} год`;
  return `${Math.floor(hours / 24)} дн`;
}

function healthMeta(value: ReturnType<typeof healthForAlerts>) {
  if (value === "critical") return { label: "Critical", cls: "healthCritical", icon: "●" };
  if (value === "action") return { label: "Action Required", cls: "healthAction", icon: "●" };
  if (value === "watch") return { label: "Watch", cls: "healthWatch", icon: "●" };
  return { label: "Healthy", cls: "healthHealthy", icon: "●" };
}

export default async function TasksDashboard() {
  const { alerts, configs, projectNames, owners } = await getPerformanceDashboardData();
  const enabledConfigs = configs.filter((c) => c.enabled);
  const open = alerts.filter((a) => !a.resolved_at && ["critical", "action_required"].includes(a.severity));
  const inProgress = open.filter((a) => a.acknowledged_at);
  const waiting = open.filter((a) => !a.acknowledged_at);
  const critical = open.filter((a) => a.severity === "critical");
  const warnings = alerts.filter((a) => !a.resolved_at && a.severity === "warning");
  const overdue = waiting.filter((a) => Date.now() - new Date(a.last_seen_at).getTime() >= 4 * 3600000);
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const doneToday = alerts.filter((a) => a.resolved_at && new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(a.resolved_at)) === todayKey);

  const byAccount = new Map<string, typeof alerts>();
  for (const alert of alerts.filter((a) => !a.resolved_at)) {
    const rows = byAccount.get(alert.meta_account_id) || [];
    rows.push(alert);
    byAccount.set(alert.meta_account_id, rows);
  }

  const projectCards = enabledConfigs.map((config) => {
    const rows = byAccount.get(config.meta_account_id) || [];
    const health = healthForAlerts(rows);
    return {
      config,
      rows,
      health,
      meta: healthMeta(health),
      open: rows.filter((a) => ["critical", "action_required"].includes(a.severity)).length,
      critical: rows.filter((a) => a.severity === "critical").length,
      warning: rows.filter((a) => a.severity === "warning").length,
    };
  }).sort((a, b) => {
    const weight = { critical: 4, action: 3, watch: 2, healthy: 1 } as const;
    return weight[b.health] - weight[a.health];
  });

  const needsAttention = open.slice().sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    if (Boolean(a.acknowledged_at) !== Boolean(b.acknowledged_at)) return a.acknowledged_at ? 1 : -1;
    return new Date(a.last_seen_at).getTime() - new Date(b.last_seen_at).getTime();
  });

  const healthyProjects = projectCards.filter((p) => p.health === "healthy").length;
  const attentionProjects = projectCards.filter((p) => p.health === "action" || p.health === "critical").length;
  const watchProjects = projectCards.filter((p) => p.health === "watch").length;

  const timeline = alerts.slice(0, 10);

  return <main className="adminShell">
    <aside className="sidebar">
      <div className="brandBlock"><div className="brandMark">//</div><div><strong>PTS</strong><span>COOPERATION</span></div></div>
      <nav className="sideNav">
        <Link href="/" className="sideNavItem"><span>⌂</span>Overview</Link>
        <Link href="/tasks" className="sideNavItem active"><span>⚡</span>Performance OS</Link>
        <Link href="/#accounts" className="sideNavItem"><span>◉</span>Accounts</Link>
        <Link href="/#reporting" className="sideNavItem"><span>▥</span>Reporting</Link>
        <Link href="/diagnostics" className="sideNavItem"><span>⌁</span>Diagnostics</Link>
        <Link href="/#accounts" className="sideNavItem"><span>▣</span>Billing</Link>
        <Link href="/#accounts" className="sideNavItem"><span>➤</span>Telegram</Link>
      </nav>
      <div className="automationCard">
        <div className="automationHead"><span>Performance OS</span><b>LIVE</b></div>
        <div className="automationMeta">Tasks · Health · Team control</div>
        <div className="pulseBars" aria-hidden="true">{Array.from({ length: 18 }).map((_, i) => <i key={i} style={{ height: `${8 + ((i * 9) % 22)}px` }} />)}</div>
        <div className="automationFoot"><span>Monitoring</span><span className="ok">● online</span></div>
      </div>
    </aside>

    <section className="workspace">
      <header className="topBar">
        <div className="searchGhost">⚡ Performance OS · Command Center</div>
        <div className="systemOnline"><span className="dot ok"/>Live data from Performance Control</div>
      </header>

      <div className="shell performanceShell">
        <section className="performanceHero">
          <div>
            <div className="eyebrow purpleText">PTS Performance OS · Live Control</div>
            <h1>Performance <span className="violetGradient">Command Center</span></h1>
            <p className="subtitle">Тут тільки те, що потрібно для керування командою: де горить, хто вже взяв задачу, які проєкти здорові та що відбулось останнім.</p>
          </div>
          <div className="heroStatusCluster">
            <div className="heroStatusDot" />
            <div><strong>{critical.length ? `${critical.length} critical зараз` : "Критичних проблем немає"}</strong><span>{waiting.length} очікують реакції · {inProgress.length} у роботі</span></div>
          </div>
        </section>

        <section className="commandMetrics">
          <div className="commandMetric danger"><span className="commandMetricIcon">!</span><div><small>ПОТРЕБУЮТЬ УВАГИ</small><strong>{open.length}</strong><p>{waiting.length} ще без ACK</p></div></div>
          <div className="commandMetric progress"><span className="commandMetricIcon">↗</span><div><small>В РОБОТІ</small><strong>{inProgress.length}</strong><p>таргетологи вже взяли</p></div></div>
          <div className="commandMetric success"><span className="commandMetricIcon">✓</span><div><small>ЗАКРИТО СЬОГОДНІ</small><strong>{doneToday.length}</strong><p>готових задач</p></div></div>
          <div className="commandMetric warning"><span className="commandMetricIcon">⌛</span><div><small>OVERDUE</small><strong>{overdue.length}</strong><p>4+ год без ACK</p></div></div>
        </section>

        <section className="performanceOverviewGrid">
          <div className="commandPanel attentionPanel">
            <div className="commandPanelHead">
              <div><span className="eyebrow purpleText">PRIORITY QUEUE</span><h2>Що потребує уваги зараз</h2></div>
              <span className="livePill"><i/>LIVE</span>
            </div>
            <div className="priorityList">
              {needsAttention.length ? needsAttention.slice(0, 8).map((a) => {
                const project = projectNames.get(a.meta_account_id) || a.meta_account_id;
                const owner = owners.get(a.meta_account_id) || "Не призначено";
                return <div className={`priorityItem ${a.severity === "critical" ? "criticalTask" : "actionTask"}`} key={a.id}>
                  <div className="priorityRail" />
                  <div className="priorityMain">
                    <div className="priorityTop"><strong>{project}</strong><span className={a.severity === "critical" ? "bad" : "warn"}>{a.severity === "critical" ? "CRITICAL" : "ACTION"}</span></div>
                    <div className="priorityTitle">{a.title}</div>
                    <div className="priorityMeta"><span>{owner}</span><span>Alert #{a.id}</span><span>{age(a.last_seen_at)}</span></div>
                  </div>
                  <div className={`taskState ${a.acknowledged_at ? "stateProgress" : "stateWaiting"}`}>{a.acknowledged_at ? "In progress" : "Waiting ACK"}</div>
                </div>;
              }) : <div className="zeroState"><span>✓</span><strong>Черга порожня</strong><p>Немає Critical або Action Required задач.</p></div>}
            </div>
          </div>

          <div className="commandPanel pulsePanel">
            <div className="commandPanelHead"><div><span className="eyebrow purpleText">NETWORK HEALTH</span><h2>Стан усіх проєктів</h2></div></div>
            <div className="healthDonutWrap">
              <div className="healthDonut"><div><strong>{enabledConfigs.length}</strong><span>projects</span></div></div>
              <div className="healthLegend">
                <div><i className="legendHealthy"/><span>Healthy</span><strong>{healthyProjects}</strong></div>
                <div><i className="legendWatch"/><span>Watch</span><strong>{watchProjects}</strong></div>
                <div><i className="legendAction"/><span>Action</span><strong>{attentionProjects}</strong></div>
                <div><i className="legendCritical"/><span>Critical</span><strong>{projectCards.filter((p) => p.health === "critical").length}</strong></div>
              </div>
            </div>
            <div className="miniSignalGrid">
              <div><span>Warnings</span><strong>{warnings.length}</strong></div>
              <div><span>Critical tasks</span><strong className="bad">{critical.length}</strong></div>
              <div><span>Waiting ACK</span><strong className="warn">{waiting.length}</strong></div>
              <div><span>Done today</span><strong className="ok">{doneToday.length}</strong></div>
            </div>
          </div>
        </section>

        <section className="commandPanel projectsMatrixPanel">
          <div className="commandPanelHead">
            <div><span className="eyebrow purpleText">PROJECT MATRIX</span><h2>Health map</h2><p>Спочатку показуємо те, де є проблема. Healthy — нижче.</p></div>
            <span className="statusPill violetPill">{enabledConfigs.length} monitored</span>
          </div>
          <div className="projectHealthGrid">
            {projectCards.map(({ config, meta, open: openCount, critical: criticalCount, warning }) => <div className={`projectHealthCard ${meta.cls}`} key={config.meta_account_id}>
              <div className="projectCardTop"><div><span className="projectHealthDot">{meta.icon}</span><strong>{config.project_name}</strong></div><span className="healthBadge">{meta.label}</span></div>
              <div className="projectOwner">{config.targetologist_telegram || "Без відповідального"}</div>
              <div className="projectSignals">
                <div><span>Open</span><strong>{openCount}</strong></div>
                <div><span>Critical</span><strong>{criticalCount}</strong></div>
                <div><span>Watch</span><strong>{warning}</strong></div>
              </div>
            </div>)}
          </div>
        </section>

        <section className="performanceBottomGrid">
          <div className="commandPanel">
            <div className="commandPanelHead"><div><span className="eyebrow purpleText">TEAM FLOW</span><h2>Що відбувається з задачами</h2></div></div>
            <div className="flowStages">
              <div className="flowStage"><span>01</span><strong>Detected</strong><b>{open.length}</b><small>бот знайшов проблему</small></div>
              <div className="flowArrow">→</div>
              <div className="flowStage"><span>02</span><strong>ACK</strong><b>{inProgress.length}</b><small>взято в роботу</small></div>
              <div className="flowArrow">→</div>
              <div className="flowStage"><span>03</span><strong>Done</strong><b>{doneToday.length}</b><small>закрито сьогодні</small></div>
            </div>
          </div>

          <div className="commandPanel timelinePanel">
            <div className="commandPanelHead"><div><span className="eyebrow purpleText">ACTIVITY STREAM</span><h2>Останні події</h2></div></div>
            <div className="timelineStream">
              {timeline.map((a) => {
                const notes = Array.isArray(a.details?.notes) ? a.details.notes as Array<{note?:string;at?:string}> : [];
                const lastNote = notes.at(-1);
                const state = a.resolved_at ? "Закрито" : a.acknowledged_at ? "В роботі" : "Створено";
                return <div className="timelineEvent" key={a.id}>
                  <span className={`timelineDot ${a.resolved_at ? "done" : a.severity === "critical" ? "critical" : "active"}`}/>
                  <div><div className="timelineTop"><strong>{projectNames.get(a.meta_account_id) || a.meta_account_id}</strong><span>#{a.id}</span></div><p>{a.title}</p>{lastNote?.note ? <small>📝 {lastNote.note}</small> : <small>{state} · {age(a.first_seen_at)}</small>}</div>
                </div>;
              })}
            </div>
          </div>
        </section>
      </div>
    </section>
  </main>;
}
