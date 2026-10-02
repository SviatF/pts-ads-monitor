import Link from "next/link";
import { getTaskManagerDashboardData } from "@/lib/task-manager-dashboard";

export const dynamic = "force-dynamic";

function formatDate(value: string | null, timezone = "Europe/Kyiv") {
  if (!value) return "Без дедлайну";
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function displayName(user: { first_name: string | null; last_name: string | null; username: string | null; telegram_user_id: number }) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || (user.username ? `@${user.username}` : `User ${user.telegram_user_id}`);
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "U";
}

function sessionLabel(state: string) {
  const map: Record<string, string> = {
    await_title: "створює задачу · назва",
    await_project: "створює задачу · проєкт",
    await_deadline: "створює задачу · дедлайн",
    await_time: "створює задачу · час",
    await_manual_time: "створює задачу · ручний час",
    await_custom_deadline: "створює задачу · дата",
    await_priority: "створює задачу · пріоритет",
  };
  return map[state] || state;
}

export default async function TaskManagerDashboard() {
  const { users, totals, tasks } = await getTaskManagerDashboardData();
  const recentActivity = tasks.slice().sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, 20);

  return (
    <main className="adminShell">
      <aside className="sidebar">
        <div className="brandBlock">
          <div className="brandMark">//</div>
          <div><strong>PTS</strong><span>COOPERATION</span></div>
        </div>
        <nav className="sideNav">
          <Link href="/" className="sideNavItem"><span>⌂</span>Overview</Link>
          <Link href="/tasks" className="sideNavItem"><span>⚡</span>Performance OS</Link>
          <Link href="/task-manager" className="sideNavItem active"><span>✓</span>Task Manager</Link>
          <Link href="/#accounts" className="sideNavItem"><span>◉</span>Accounts</Link>
          <Link href="/#reporting" className="sideNavItem"><span>▥</span>Reporting</Link>
          <Link href="/diagnostics" className="sideNavItem"><span>⌁</span>Diagnostics</Link>
          <Link href="/#accounts" className="sideNavItem"><span>▣</span>Billing</Link>
          <Link href="/#accounts" className="sideNavItem"><span>➤</span>Telegram</Link>
        </nav>
        <div className="automationCard">
          <div className="automationHead"><span>PTS Tasks</span><b>LIVE</b></div>
          <div className="automationMeta">Personal tasks · deadlines · activity</div>
          <div className="pulseBars" aria-hidden="true">{Array.from({ length: 18 }).map((_, i) => <i key={i} style={{ height: `${8 + ((i * 11) % 22)}px` }} />)}</div>
          <div className="automationFoot"><span>Telegram sync</span><span className="ok">● online</span></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topBar">
          <div className="searchGhost">✓ PTS Tasks · Team Dashboard</div>
          <div className="systemOnline"><span className="dot ok" />Live from Telegram Task Bot</div>
        </header>

        <div className="shell taskManagerShell">
          <section className="taskManagerHero">
            <div>
              <div className="eyebrow purpleText">PTS Cooperation · Personal Productivity</div>
              <h1>Task <span className="violetGradient">Manager</span></h1>
              <p className="subtitle">Усі задачі, які команда створює у Telegram-боті, автоматично відображаються тут: активні, прострочені, виконані, поточна активність і дедлайни по кожному користувачу.</p>
            </div>
            <div className="tmHeroMeta">
              <span className="tmChip">Telegram → Dashboard</span><span className="tmChip">Auto reminders</span><span className="tmChip">Live team activity</span>
            </div>
          </section>

          <section className="tmMetrics">
            <div className="tmMetric"><span>Користувачів</span><strong>{totals.users}</strong></div>
            <div className="tmMetric"><span>Активних задач</span><strong>{totals.active}</strong></div>
            <div className="tmMetric badMetric"><span>Прострочено</span><strong className="bad">{totals.overdue}</strong></div>
            <div className="tmMetric okMetric"><span>Закрито сьогодні</span><strong className="ok">{totals.completedToday}</strong></div>
            <div className="tmMetric"><span>Закрито всього</span><strong>{totals.completedAll}</strong></div>
          </section>

          <div className="tmUsersHeader">
            <div><span className="eyebrow purpleText">TEAM TASKS</span><h2>Команда та активність</h2></div>
            <span className="statusPill violetPill">{users.length} users</span>
          </div>

          {users.length ? (
            <section className="tmUserGrid">
              {users.map(({ user, active, overdue, dueToday, completedToday, recentCompleted, session }) => {
                const name = displayName(user);
                const overdueIds = new Set(overdue.map((task) => task.id));
                return (
                  <article className={`tmUserCard ${overdue.length ? "hasOverdue" : ""}`} key={user.telegram_user_id}>
                    <div className="tmUserHead">
                      <div className="tmIdentity">
                        <div className="tmAvatar">{initials(name)}</div>
                        <div><strong>{name}</strong><small>{user.username ? `@${user.username}` : `ID ${user.telegram_user_id}`}</small></div>
                      </div>
                      <div className="tmUserState">{session ? "● active now" : "● connected"}</div>
                    </div>
                    <div className="tmUserStats">
                      <div><span>Active</span><strong>{active.length}</strong></div>
                      <div><span>Today</span><strong>{dueToday.length}</strong></div>
                      <div><span>Overdue</span><strong className={overdue.length ? "bad" : ""}>{overdue.length}</strong></div>
                      <div><span>Done today</span><strong className="ok">{completedToday.length}</strong></div>
                    </div>
                    <div className="tmCardBody">
                      <div className="tmSectionTitle"><strong>Активні задачі</strong><span>{active.length} total</span></div>
                      <div className="tmTaskList">
                        {active.length ? active.slice(0, 8).map((task) => (
                          <div className={`tmTaskRow ${overdueIds.has(task.id) ? "overdue" : ""}`} key={task.id}>
                            <span className={`tmTaskPriority ${task.priority}`} />
                            <div className="tmTaskMain"><strong>{task.title}</strong><small>{task.project_name || "Без проєкту"} · Task #{task.id}</small></div>
                            <div className={`tmDue ${overdueIds.has(task.id) ? "bad" : ""}`}>{overdueIds.has(task.id) ? "OVERDUE · " : ""}{formatDate(task.due_at, user.timezone)}</div>
                          </div>
                        )) : <div className="tmEmpty">Активних задач немає.</div>}
                      </div>
                      {active.length > 8 ? <div className="tmSession">Ще <b>{active.length - 8}</b> активних задач не показано у картці.</div> : null}
                      <div className="tmCompleted">
                        <div className="tmSectionTitle"><strong>Останні виконані</strong><span>{recentCompleted.length ? "recent" : "empty"}</span></div>
                        {recentCompleted.length ? recentCompleted.map((task) => <div className="tmCompletedRow" key={task.id}><b>✓ {task.title}</b><span>{formatDate(task.completed_at, user.timezone)}</span></div>) : <div className="tmEmpty">Ще немає виконаних задач.</div>}
                      </div>
                      {session ? <div className="tmSession">⚡ Зараз у боті: <b>{sessionLabel(session.state)}</b></div> : null}
                    </div>
                  </article>
                );
              })}
            </section>
          ) : <div className="tmNoUsers">Поки ніхто не натиснув /start у PTS Tasks bot. Після першого запуску користувач автоматично з’явиться тут.</div>}

          <section className="panel tmActivityPanel">
            <div className="panelHead"><div><strong>Остання активність задачника</strong><div className="eyebrow panelSub">Створення · зміни · виконання · скасування</div></div><span className="statusPill violetPill">LIVE</span></div>
            {recentActivity.length ? <div className="tableWrap"><table className="tmActivityTable"><thead><tr><th>User</th><th>Task</th><th>Project</th><th>Status</th><th>Deadline</th><th>Updated</th></tr></thead><tbody>
              {recentActivity.map((task) => {
                const row = users.find((item) => item.user.telegram_user_id === task.owner_telegram_user_id);
                const userName = row ? displayName(row.user) : String(task.owner_telegram_user_id);
                const timezone = row?.user.timezone || "Europe/Kyiv";
                return <tr key={task.id}><td><strong>{userName}</strong></td><td>{task.title}</td><td>{task.project_name || "—"}</td><td><span className={`tmStatusTag ${task.status}`}>{task.status}</span></td><td>{formatDate(task.due_at, timezone)}</td><td>{formatDate(task.updated_at, timezone)}</td></tr>;
              })}
            </tbody></table></div> : <div className="empty">Активності ще немає.</div>}
          </section>
        </div>
      </section>
    </main>
  );
}
