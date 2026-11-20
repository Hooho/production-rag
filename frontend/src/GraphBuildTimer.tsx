import { useEffect, useState } from "react";

export function GraphBuildTimer({
  started,
  finished,
  running,
}: {
  started: string;
  finished: string | null;
  running: boolean;
}) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    setClock(Date.now());
    if (!running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [started, running]);
  const start = new Date(started).getTime();
  const end = !running && finished ? new Date(finished).getTime() : clock;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const text = [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return (
    <time className="graph-build-timer" dateTime={`PT${seconds}S`}>
      {running ? "已用时" : "总用时"} <strong>{text}</strong>
    </time>
  );
}
