export type ProjectFixture = { id: string; name: string; mediaCount: number };

export const fixtureProjects: readonly ProjectFixture[] = [
  { id: 'sample-project', name: '演示项目 · 安全帽属性检查', mediaCount: 3 },
];

export function Projects({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="projects-page" aria-labelledby="projects-heading">
      <div className="section-heading">
        <div><p className="eyebrow">项目空间</p><h1 id="projects-heading">最近项目</h1></div>
        <span className="mock-badge">DEV MOCK</span>
      </div>
      <p className="notice">这是本地开发夹具。项目、媒体与选择不会保存到后端，也不代表已登录或已持久化。</p>
      <ul className="project-cards">
        {fixtureProjects.map((project) => (
          <li key={project.id}>
            <button className="project-card" type="button" onClick={onOpen} aria-label={`打开项目 ${project.name}`}>
              <span className="project-icon" aria-hidden="true">WL</span>
              <span className="project-copy"><strong>{project.name}</strong><small>{project.mediaCount} 张媒体 · 开发夹具</small></span>
              <span aria-hidden="true">›</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
