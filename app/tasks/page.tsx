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

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function healthMeta(value: ReturnType<typeof healthForAlerts>) {
  if (value === "critical") return { label: "Critical", cls: "healthCritical", icon: "●" };
  if (value === "action") return { label: "Action Required", cls: "healthAction", icon: "●" };
  if (value === "watch") return { label: "Watch", cls: "healthWatch", icon: "●" };
  return { label: "Healthy", cls: "healthHealthy", icon: "●" };
}

function param(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export default async function TasksDashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const ownerFilter = param(params.owner);
  const healthFilter = param(params.health);
  const statusFilter = param(params.status);
  const projectFilter = param(params.project);

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

  const allProjectCards = enabledConfigs.map((config) => {
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

  const projectCards = allProjectCards.filter(({ config, health }) => {
    if (ownerFilter && (config.targetologist_telegram || "") !== ownerFilter) return false;
    if (projectFilter && config.meta_account_id !== projectFilter) return false;
    if (healthFilter && health !== healthFilter) return false;
    return true;
  });

  const needsAttention = open.filter((a) => {
    if (ownerFilter && (owners.get(a.meta_account_id) || "") !== ownerFilter) return false;
    if (projectFilter && a.meta_account_id !== projectFilter) return false;
    if (statusFilter === "waiting" && a.acknowledged_at) return false;
    if (statusFilter === "progress" && !a.acknowledged_at) return false;
    if (statusFilter === "critical" && a.severity !== "critical") return false;
    return true;
  }).sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    if (Boolean(a.acknowledged_at) !== Boolean(b.acknowledged_at)) return a.acknowledged_at ? 1 : -1;
    return new Date(a.last_seen_at).getTime() - new Date(b.last_seen_at).getTime();
  });

  const healthyProjects = allProjectCards.filter((p) => p.health === "healthy").length;
  const attentionProjects = allProjectCards.filter((p) => p.health === "action" || p.health === "critical").length;
  const watchProjects = allProjectCards.filter((p) => p.health === "watch").length;
  const timeline = alerts.slice(0, 10);

  const actionableHistory = alerts.filter((a) => ["critical", "action_required"].includes(a.severity));
  const ackTimes = actionableHistory.filter((a) => a.acknowledged_at).map((a) => (new Date(a.acknowledged_at as string).getTime() - new Date(a.first_seen_at).getTime()) / 60000).filter((v) => v >= 0 && Number.isFinite(v));
  const resolutionTimes = actionableHistory.filter((a) => a.resolved_at).map((a) => (new Date(a.resolved_at as string).getTime() - new Date(a.first_seen_at).getTime()) / 3600000).filter((v) => v >= 0 && Number.isFinite(v));
  const resolvedCount = actionableHistory.filter((a) => a.resolved_at).length;
  const closeRate = actionableHistory.length ? Math.round((resolvedCount / actionableHistory.length) * 100) : 0;
  const ownerOptions = Array.from(new Set(enabledConfigs.map((c) => c.targetologist_telegram || "").filter(Boolean))).sort();

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
            <p className="subtitle">Де горить, хто реагує, які проєкти здорові, скільки часу команда витрачає на реакцію і що відбулось останнім.</p>
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

        <section className="commandPanel" style={{ marginBottom: 12 }}>
          <div className="commandPanelHead"><div><span className="eyebrow purpleText">CONTROL FILTERS</span><h2>Зріз даних</h2></div>{(ownerFilter || healthFilter || statusFilter || projectFilter) ? <Link href="/tasks" className="statusPill violetPill">Скинути фільтри</Link> : null}</div>
          <form method="get" className="setupForm" style={{ gridTemplateColumns: "repeat(4,minmax(0,1fr)) auto", alignItems: "end" }}>
            <label>Таргетолог<select name="owner" defaultValue={ownerFilter}><option value="">Усі</option>{ownerOptions.map((owner) => <option key={owner} value={owner}>{owner}</option>)}</select></label>
            <label>Проєкт<select name="project" defaultValue={projectFilter}><option value="">Усі</option>{enabledConfigs.map((c) => <option key={c.meta_account_id} value={c.meta_account_id}>{c.project_name}</option>)}</select></label>
            <label>Health<select name="health" defaultValue={healthFilter}><option value="">Усі</option><option value="critical">Critical</option><option value="action">Action Required</option><option value="watch">Watch</option><option value="healthy">Healthy</option></select></label>
            <label>Task status<select name="status" defaultValue={statusFilter}><option value="">Усі</option><option value="critical">Critical</option><option value="waiting">Waiting ACK</option><option value="progress">In progress</option></select></label>
            <button type="submit" className="runButton primaryAction">Застосувати</button>
          </form>
        </section>

        <section className="performanceOverviewGrid">
          <div className="commandPanel attentionPanel">
            <div className="commandPanelHead"><div><span className="eyebrow purpleText">PRIORITY QUEUE</span><h2>Що потребує уваги зараз</h2></div><span className="livePill"><i/>LIVE</span></div>
            <div className="priorityList">
              {needsAttention.length ? needsAttention.slice(0, 12).map((a) => {
                const project = projectNames.get(a.meta_account_id) || a.meta_account_id;
                const owner = owners.get(a.meta_account_id) || "Не призначено";
                return <Link href={`/tasks/alert/${a.id}`} className={`priorityItem ${a.severity === "critical" ? "criticalTask" : "actionTask"}`} key={a.id} style={{ textDecoration: "none" }}>
                  <div className="priorityRail" /><div className="priorityMain"><div className="priorityTop"><strong>{project}</strong><span className={a.severity === "critical" ? "bad" : "warn"}>{a.severity === "critical" ? "CRITICAL" : "ACTION"}</span></div><div className="priorityTitle">{a.title}</div><div className="priorityMeta"><span>{owner}</span><span>Alert #{a.id}</span><span>{age(a.last_seen_at)}</span></div></div><div className={`taskState ${a.acknowledged_at ? "stateProgress" : "stateWaiting"}`}>{a.acknowledged_at ? "In progress" : "Waiting ACK"}</div>
                </Link>;
              }) : <div className="zeroState"><span>✓</span><strong>Черга порожня</strong><p>За вибраними фільтрами задач немає.</p></div>}
            </div>
          </div>

          <div className="commandPanel pulsePanel">
            <div className="commandPanelHead"><div><span className="eyebrow purpleText">NETWORK HEALTH</span><h2>Стан усіх проєктів</h2></div></div>
            <div className="healthDonutWrap"><div className="healthDonut"><div><strong>{enabledConfigs.length}</strong><span>projects</span></div></div><div className="healthLegend"><div><i className="legendHealthy"/><span>Healthy</span><strong>{healthyProjects}</strong></div><div><i className="legendWatch"/><span>Watch</span><strong>{watchProjects}</strong></div><div><i className="legendAction"/><span>Action</span><strong>{attentionProjects}</strong></div><div><i className="legendCritical"/><span>Critical</span><strong>{allProjectCards.filter((p) => p.health === "critical").length}</strong></div></div></div>
            <div className="miniSignalGrid"><div><span>Warnings</span><strong>{warnings.length}</strong></div><div><span>Critical tasks</span><strong className="bad">{critical.length}</strong></div><div><span>Waiting ACK</span><strong className="warn">{waiting.length}</strong></div><div><span>Done today</span><strong className="ok">{doneToday.length}</strong></div></div>
          </div>
        </section>

        <section className="commandMetrics">
          <div className="commandMetric progress"><span className="commandMetricIcon">⏱</span><div><small>MEDIAN ACK</small><strong>{ackTimes.length ? `${Math.round(median(ackTimes))}m` : "—"}</strong><p>час до взяття задачі</p></div></div>
          <div className="commandMetric success"><span className="commandMetricIcon">✓</span><div><small>CLOSE RATE</small><strong>{closeRate}%</strong><p>{resolvedCount}/{actionableHistory.length} закрито</p></div></div>
          <div className="commandMetric warning"><span className="commandMetricIcon">◎</span><div><small>MEDIAN RESOLUTION</small><strong>{resolutionTimes.length ? `${median(resolutionTimes).toFixed(1)}h` : "—"}</strong><p>від detect до done</p></div></div>
          <div className="commandMetric danger"><span className="commandMetricIcon">↻</span><div><small>ACTIVE LOAD</small><strong>{open.length}</strong><p>відкритих actionable</p></div></div>
        </section>

        <section className="commandPanel projectsMatrixPanel">
          <div className="commandPanelHead"><div><span className="eyebrow purpleText">PROJECT MATRIX</span><h2>Health map</h2><p>Клік по проєкту відкриває повну 30-денну історію.</p></div><span className="statusPill violetPill">{projectCards.length} shown</span></div>
          <div className="projectHealthGrid">
            {projectCards.map(({ config, meta, open: openCount, critical: criticalCount, warning }) => <Link href={`/tasks/project/${encodeURIComponent(config.meta_account_id)}`} className={`projectHealthCard ${meta.cls}`} key={config.meta_account_id} style={{ textDecoration: "none" }}><div className="projectCardTop"><div><span className="projectHealthDot">{meta.icon}</span><strong>{config.project_name}</strong></div><span className="healthBadge">{meta.label}</span></div><div className="projectOwner">{config.targetologist_telegram || "Без відповідального"}</div><div className="projectSignals"><div><span>Open</span><strong>{openCount}</strong></div><div><span>Critical</span><strong>{criticalCount}</strong></div><div><span>Watch</span><strong>{warning}</strong></div></div></Link>)}
          </div>
        </section>

        <section className="performanceBottomGrid">
          <div className="commandPanel"><div className="commandPanelHead"><div><span className="eyebrow purpleText">TEAM FLOW</span><h2>Що відбувається з задачами</h2></div></div><div className="flowStages"><div className="flowStage"><span>01</span><strong>Detected</strong><b>{open.length}</b><small>бот знайшов проблему</small></div><div className="flowArrow">→</div><div className="flowStage"><span>02</span><strong>ACK</strong><b>{inProgress.length}</b><small>взято в роботу</small></div><div className="flowArrow">→</div><div className="flowStage"><span>03</span><strong>Done</strong><b>{doneToday.length}</b><small>закрито сьогодні</small></div></div></div>
          <div className="commandPanel timelinePanel"><div className="commandPanelHead"><div><span className="eyebrow purpleText">ACTIVITY STREAM</span><h2>Останні події</h2></div></div><div className="timelineStream">{timeline.map((a) => { const notes = Array.isArray(a.details?.notes) ? a.details.notes as Array<{note?:string;at?:string}> : []; const lastNote = notes.at(-1); const state = a.resolved_at ? "Закрито" : a.acknowledged_at ? "В роботі" : "Створено"; return <Link href={`/tasks/alert/${a.id}`} className="timelineEvent" key={a.id} style={{ textDecoration: "none" }}><span className={`timelineDot ${a.resolved_at ? "done" : a.severity === "critical" ? "critical" : "active"}`}/><div><div className="timelineTop"><strong>{projectNames.get(a.meta_account_id) || a.meta_account_id}</strong><span>#{a.id}</span></div><p>{a.title}</p>{lastNote?.note ? <small>📝 {lastNote.note}</small> : <small>{state} · {age(a.first_seen_at)}</small>}</div></Link>; })}</div></div>
        </section>
      </div>
    </section>
  </main>;
}
