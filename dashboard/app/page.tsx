export default function Home() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold tracking-tight">概览</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        加密货币自动跟单机器人控制面板。从左侧导航进入 KOL 管理和频道管理。
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <DashCard title="信号" value="—" sub="等待接入 Discord" />
        <DashCard title="待审批" value="—" sub="审批队列为空" />
        <DashCard title="今日交易" value="—" sub="无交易记录" />
      </div>
    </div>
  );
}

function DashCard({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {title}
      </p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}
