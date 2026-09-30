import type { CSSProperties, ReactNode } from "react";

type SkeletonProps = {
  className?: string;
  style?: CSSProperties;
};

// 统一的占位块：原来的加载态只显示文字，页面结构会突然跳变；骨架块先保留内容轮廓，减少等待时的布局抖动。
export function SkeletonBlock({ className = "", style }: SkeletonProps) {
  return <span className={`skeleton-block ${className}`} style={style} aria-hidden="true" />;
}

// 所有异步读取都使用同一个可访问容器，视觉上展示骨架，辅助技术仍能知道当前区域正在加载。
export function LoadingSkeleton({ children, className = "", label = "正在加载" }: { children: ReactNode; className?: string; label?: string }) {
  return <div className={`loading-skeleton ${className}`} role="status" aria-busy="true" aria-label={label}>{children}</div>;
}
