import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./CloudComputePanel.css";

type AuthStatus = { logged_in: boolean; account: string | null; remembered?: boolean };
type Catalog = { source: string; plans: string[]; backends: string[]; models: string[] };
export type CloudComputePanelProps = {
  connected: boolean;
  busy: boolean;
  reconnectStatus?: string;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
};

// Only known static backend diagnostics may reach the UI; never render an arbitrary response.
function connectionErrorMessage(error: unknown): string {
  const value = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const known: Record<string, string> = {
    "Cloud DNS lookup timeout": "云端域名解析超时。",
    "Cloud TCP connection timeout": "云端网络连接超时。",
    "Cloud TLS or WebSocket handshake timeout": "云端 TLS / WebSocket 握手超时。",
    "Cloud Engine.IO open timeout": "WebSocket 已连接，但未收到 Engine.IO 握手消息。",
    "Cloud Socket.IO connect timeout": "Engine.IO 已连接，但 Socket.IO 会话未建立。",
    "Cloud Socket.IO namespace is unsupported": "云服务返回了非默认 Socket.IO 命名空间，当前客户端尚未支持。",
    "Cloud heartbeat timeout": "云端连接心跳超时。",
    "Cloud engine ready timeout": "云连接已建立，但引擎在 60 秒内未准备好。请稍后重试。",
    "Cloud TLS or WebSocket handshake failed": "云端 TLS / WebSocket 握手失败，请检查网络。",
    "Cloud TCP connection failed": "无法建立云端网络连接。",
    "Cloud DNS lookup failed": "无法解析云端服务器地址。",
    "Cloud Socket.IO connection rejected": "云端拒绝 Socket.IO 会话，请重新登录后重试。",
    "智子云连接地址未通过官方域名校验": "云服务返回的连接地址未通过校验。请反馈此提示以核对服务地址。",
    "智子云登录已过期，请重新登录": "智子云登录已过期，请退出后重新登录。",
    "智子云拒绝访问，请检查 VIP 资格": "云端拒绝访问，请检查 VIP 资格。",
  };
  const diagnostic = value.replace(/^智子云连接失败[：:] ?/, "");
  return known[diagnostic] ?? "连接 VIP 算力失败；请查看云连接诊断后重试。";
}

export function CloudComputePanel({ connected, busy, reconnectStatus, onConnect, onDisconnect }: CloudComputePanelProps) {
  const desktop = typeof window !== "undefined" && isTauri();
  const [auth, setAuth] = useState<AuthStatus>({ logged_in: false, account: null });
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selection, setSelection] = useState({ plan: "vip-share", backend: "katago-TENSORRT", model: "28bnbt" });
  const [checking, setChecking] = useState(desktop);
  const [action, setAction] = useState<"login" | "logout" | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  const authLock = useRef(false);
  const connectLock = useRef(false);
  const disconnectLock = useRef(false);
  const connectionGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    if (desktop) {
      invoke<typeof selection>("zhizi_get_selection").then(value => { if (current) setSelection(value); }).catch(() => {});
      invoke<Catalog>("zhizi_catalog").then((value) => { if (current) setCatalog(value); }).catch(() => {});
      invoke<AuthStatus>("zhizi_status")
        .then((status) => { if (current) setAuth(status); })
        .catch(() => { if (current) setMessage("无法读取智子云登录状态，请重新登录。"); })
        .finally(() => { if (current) setChecking(false); });
    }
    return () => { current = false; mounted.current = false; };
  }, [desktop]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!desktop || checking || authLock.current || !account.trim() || !password) return;
    authLock.current = true;
    setAction("login");
    setMessage("");
    const submittedPassword = password;
    setPassword("");
    try {
      const status = await invoke<AuthStatus>("zhizi_login", { account: account.trim(), password: submittedPassword, remember });
      if (!mounted.current) return;
      setAuth(status);
      if (status.logged_in) setAccount("");
      setMessage(status.logged_in ? "登录成功，可连接 VIP 共享算力。" : "登录未成功，请检查账号和密码。");
    } catch {
      if (mounted.current) setMessage("登录失败，请检查账号、密码和网络后重试。");
    } finally {
      authLock.current = false;
      if (mounted.current) { setPassword(""); setAction(null); }
    }
  }

  async function connect() {
    if (!desktop || !auth.logged_in || checking || authLock.current || connectLock.current || disconnectLock.current || connected || busy) return;
    connectLock.current = true;
    const generation = ++connectionGeneration.current;
    setConnecting(true);
    setMessage("");
    try {
      await invoke("zhizi_set_selection", { selection });
      await onConnect();
    } catch (error) {
      if (mounted.current && generation === connectionGeneration.current) setMessage(connectionErrorMessage(error));
    } finally {
      connectLock.current = false;
      if (mounted.current) setConnecting(false);
    }
  }

  async function disconnect() {
    if (disconnectLock.current || authLock.current) return;
    disconnectLock.current = true;
    ++connectionGeneration.current;
    setDisconnecting(true);
    setMessage(busy || connecting ? "已请求断开；等待启动请求结束后释放云算力，请稍候。" : "正在断开云算力…");
    try {
      await onDisconnect();
      if (mounted.current) setMessage("云算力已断开。");
    } catch {
      if (mounted.current) setMessage("断开云算力失败，请重试。");
    } finally {
      disconnectLock.current = false;
      if (mounted.current) setDisconnecting(false);
    }
  }

  async function logout() {
    if (!desktop || authLock.current || disconnectLock.current) return;
    authLock.current = true;
    ++connectionGeneration.current;
    setAction("logout");
    setMessage(busy || connecting ? "等待启动请求结束并断开云算力后退出登录，请稍候。" : "");
    let stopped = false;
    try {
      await onDisconnect();
      stopped = true;
      await invoke("zhizi_logout");
      if (mounted.current) {
        setAuth({ logged_in: false, account: null });
        setAccount("");
        setPassword("");
        setMessage("已退出智子云登录。");
      }
    } catch {
      if (mounted.current) setMessage(stopped ? "云算力已断开，但退出登录失败，请重试。" : "断开云算力失败，尚未退出登录，请重试。");
    } finally {
      authLock.current = false;
      if (mounted.current) setAction(null);
    }
  }

  async function restore() {
    if (authLock.current) return;
    authLock.current = true; setAction("login");
    try {
      const status = await invoke<AuthStatus>("zhizi_restore_login");
      if (mounted.current) { setAuth(status); setMessage(status.logged_in ? "已从钥匙串恢复登录，连接时校验有效期。" : "钥匙串中没有保存的登录。"); }
    } catch { if (mounted.current) setMessage("无法恢复登录，请使用密码登录。"); }
    finally { authLock.current = false; if (mounted.current) setAction(null); }
  }
  const pending = busy || connecting;
  return (
    <section className="cloud-compute-panel" aria-label="智子云算力">
      <div className="cloud-compute-heading">
        <div><h3>智子云算力</h3><p>KataGo · {selection.plan === "vip-share" ? "VIP 共享" : selection.plan} · {selection.model}</p></div>
        <span className={`cloud-compute-badge${connected ? " is-connected" : ""}`}>{connected ? "已连接" : pending ? "连接中" : "未连接"}</span>
      </div>
      {!desktop ? <p className="cloud-compute-notice">请在桌面应用中登录并连接智子云，浏览器预览不提供云算力。</p> : checking ? <p role="status">正在检查登录状态…</p> : auth.logged_in ? (
        <div className="cloud-compute-account"><span>已登录{auth.account ? ` · ${auth.account}` : ""}</span><button type="button" className="cloud-compute-secondary" disabled={action !== null || disconnecting} onClick={() => void logout()}>{action === "logout" ? "正在退出…" : "退出登录"}</button></div>
      ) : (
        <form className="cloud-compute-login" onSubmit={(event) => void login(event)}>
          <label>手机号 / 邮箱<input type="text" autoComplete="username" value={account} disabled={action !== null} onChange={(event) => setAccount(event.target.value)} placeholder="智子云账号" required /></label>
          <label>密码<input type="password" autoComplete="current-password" value={password} disabled={action !== null} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" required /></label>
          <label className="cloud-remember"><input type="checkbox" checked={remember} disabled={action !== null} onChange={(event) => setRemember(event.target.checked)} />记住登录（系统钥匙串）</label>
          <button type="button" disabled={action !== null} onClick={() => void restore()}>从钥匙串恢复登录</button>
          <button type="submit" disabled={action !== null || !account.trim() || !password}>{action === "login" ? "正在登录…" : "登录智子云"}</button>
        </form>
      )}
      {catalog && auth.logged_in && <div className="cloud-selection">
        <label>算力套餐<select value={selection.plan} disabled={connected || pending} onChange={(event) => setSelection((s) => ({ ...s, plan: event.target.value, backend: event.target.value === "1x" ? s.backend : "katago-TENSORRT" }))}>{catalog.plans.map((v) => <option key={v} value={v}>{v === "vip-share" ? "VIP 共享" : v}</option>)}</select></label>
        <label>模型<select value={selection.model} disabled={connected || pending} onChange={(event) => setSelection((s) => ({ ...s, model: event.target.value }))}>{catalog.models.map((v) => <option key={v}>{v}</option>)}</select></label>
        <small>{catalog.source}；实际可用性与账户资格以服务响应为准。</small>
      </div>}
      {auth.logged_in && <><p className="cloud-compute-hint">登录后需单独连接算力。非 VIP 套餐可能消耗账户余额；仅在点击连接后请求所选算力。</p>
      <div className="cloud-compute-actions">
        {connected || pending ? <button type="button" disabled={!desktop || action !== null || disconnecting} onClick={() => void disconnect()}>{disconnecting ? "等待断开完成…" : pending && !connected ? "请求取消连接" : "断开云算力"}</button> : <button type="button" disabled={!desktop || checking || !auth.logged_in || action !== null || disconnecting} onClick={() => void connect()}>连接所选算力</button>}
      </div>
      </>}
      {reconnectStatus && <p role="status" className="cloud-compute-notice">{reconnectStatus}</p>}
      {message && <p className="cloud-compute-notice" role="status" aria-live="polite">{message}</p>}
    </section>
  );
}
