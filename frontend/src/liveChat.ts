// 正在回答的问题的状态（问题、已收到的阶段、已生成的文字、Agent 轮次、出错信息），按会话保存在模块里。
// 以前这些放在 Chat 组件的 state 里：回答过程中切到别的页面，Chat 被卸载，状态全丢；
// 切回来看不到正在处理的问题，再提问又被后端拒绝（“该会话正在回答”）。请求本身其实还在继续。
// 现在请求的回调写到这里，Chat 重新显示时从这里读，正在处理的问题和进度都还在，处理完照常进入消息列表。
import { useSyncExternalStore } from "react";
import type { AgentRound, ChatMode, TraceStep } from "./api";

export type LiveChat = {
  question: string;
  mode: ChatMode;
  busy: boolean;
  steps: TraceStep[];
  answer: string;
  rounds: AgentRound[];
  error: string;
};

const states = new Map<string, LiveChat>();
const listeners = new Set<() => void>();
// 刚问完的问题的 Agent 轮次：Chat 被卸载时也要留着，回来展开执行链不用再向后端读。
const finishedRounds = new Map<string, AgentRound[]>();

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveChat(sessionId: string) {
  return useSyncExternalStore(subscribe, () => states.get(sessionId));
}

export function getLiveChat(sessionId: string) {
  return states.get(sessionId);
}

// 每次更新都换成新对象，useSyncExternalStore 才能发现变化。
export function updateLiveChat(sessionId: string, change: (current: LiveChat) => LiveChat) {
  const current = states.get(sessionId);
  if (!current) return;
  states.set(sessionId, change(current));
  notify();
}

export function startLiveChat(sessionId: string, question: string, mode: ChatMode) {
  states.set(sessionId, { question, mode, busy: true, steps: [], answer: "", rounds: [], error: "" });
  notify();
}

export function clearLiveChat(sessionId: string) {
  states.delete(sessionId);
  notify();
}

export function saveFinishedRounds(requestId: string, rounds: AgentRound[]) {
  finishedRounds.set(requestId, rounds);
}

export function finishedRoundsFor(requestId: string) {
  return finishedRounds.get(requestId);
}
