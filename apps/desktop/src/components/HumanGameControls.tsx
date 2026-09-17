import { useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { defaultGameOptions } from "../domain/humanGame";
import type { useHumanGame } from "../hooks/useHumanGame";
import "./HumanGameControls.css";
export function HumanGameControls({
  controller,
  disabled,
}: {
  controller: ReturnType<typeof useHumanGame>;
  disabled: boolean;
}) {
  const [show, setShow] = useState(false),
    [options, setOptions] = useState(defaultGameOptions),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const s = controller.state;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button disabled={disabled && !s} onClick={() => setShow(true)}>
        {s ? "对弈控制" : "人机对弈"}
      </button>
      {show &&
        createPortal(
          <div
            className="human-game-backdrop"
            onClick={() => !busy && setShow(false)}
          >
            <section
              className="human-game-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="人机对弈"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !busy) setShow(false);
              }}
            >
              <header>
                <h2>人机对弈</h2>
                <button
                  aria-label="关闭对弈设置"
                  disabled={busy}
                  onClick={() => setShow(false)}
                >
                  ×
                </button>
              </header>
              {s ? (
                <>
                  <p role="status">{s.status}</p>
                  <div className="human-game-actions">
                    <button
                      disabled={busy || s.phase !== "human"}
                      onClick={() => void run(() => controller.play("pass"))}
                    >
                      停一手
                    </button>
                    <button
                      disabled={busy || s.phase === "preparing"}
                      onClick={() => void run(controller.undo)}
                    >
                      悔棋
                    </button>
                    <button
                      disabled={
                        busy || s.phase === "ended" || s.phase === "preparing"
                      }
                      onClick={() => void run(controller.resign)}
                    >
                      认输
                    </button>
                    {s.phase === "error" && (
                      <button
                        disabled={busy}
                        onClick={() => void run(controller.retry)}
                      >
                        重试
                      </button>
                    )}
                    <button
                      disabled={busy || s.phase === "preparing"}
                      onClick={() =>
                        void run(async () => {
                          await controller.finish();
                          setShow(false);
                        })
                      }
                    >
                      结束并返回复盘
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="human-game-grid">
                    <label>
                      算力来源
                      <select
                        value={options.source}
                        onChange={(e) =>
                          setOptions({
                            ...options,
                            source: e.target.value as typeof options.source,
                            mode: "standard",
                          })
                        }
                      >
                        <option value="local">本地 KataGo</option>
                        <option value="cloud">已连接的智子云</option>
                        <option value="ssh">已连接的 SSH 引擎</option>
                      </select>
                    </label>
                    <label>
                      模式
                      <select
                        value={options.mode}
                        onChange={(e) =>
                          setOptions({
                            ...options,
                            mode: e.target.value as typeof options.mode,
                          })
                        }
                      >
                        <option value="standard">标准 KataGo 对弈</option>
                        <option
                          disabled={options.source !== "local"}
                          value="human"
                        >
                          HumanSL 人类风格陪练
                        </option>
                      </select>
                    </label>
                    <label>
                      起始局面
                      <select
                        value={String(options.continuation)}
                        onChange={(e) =>
                          setOptions({
                            ...options,
                            continuation: e.target.value === "true",
                          })
                        }
                      >
                        <option value="false">新对局</option>
                        <option value="true">从当前局面续弈</option>
                      </select>
                    </label>
                    <label>
                      我执
                      <select
                        value={options.color}
                        onChange={(e) =>
                          setOptions({
                            ...options,
                            color: e.target.value as "black" | "white",
                          })
                        }
                      >
                        <option value="black">黑棋</option>
                        <option value="white">白棋</option>
                      </select>
                    </label>
                    <label>
                      每手计算上限（秒）
                      <input
                        type="number"
                        min="0.1"
                        max="600"
                        step="0.1"
                        value={options.seconds}
                        onChange={(e) =>
                          setOptions({
                            ...options,
                            seconds: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    {options.mode === "standard" ? (
                      <label>
                        每手计算量上限
                        <input
                          type="number"
                          min="1"
                          max="10000000"
                          value={options.visits}
                          onChange={(e) =>
                            setOptions({
                              ...options,
                              visits: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    ) : (
                      <>
                        <label>
                          人类风格档位
                          <select
                            value={options.rank}
                            onChange={(e) =>
                              setOptions({ ...options, rank: e.target.value })
                            }
                          >
                            {[
                              ...Array.from(
                                { length: 20 },
                                (_, i) => `${20 - i}k`,
                              ),
                              ...Array.from(
                                { length: 9 },
                                (_, i) => `${i + 1}d`,
                              ),
                            ].map((rank) => (
                              <option key={rank} value={`rank_${rank}`}>
                                {rank}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          HumanSL 模型
                          <button
                            onClick={() =>
                              void run(async () => {
                                const path = await open({
                                  multiple: false,
                                  directory: false,
                                });
                                if (typeof path === "string")
                                  setOptions({ ...options, humanModel: path });
                              })
                            }
                          >
                            选择模型文件
                          </button>
                          <small>
                            {options.humanModel || "需单独下载人类模型"}
                          </small>
                        </label>
                      </>
                    )}
                    {!options.continuation && (
                      <>
                        <label>
                          棋盘
                          <select
                            value={options.size}
                            onChange={(e) =>
                              setOptions({
                                ...options,
                                size: Number(e.target.value),
                                handicap: 0,
                              })
                            }
                          >
                            {[9, 13, 19].map((n) => (
                              <option key={n}>{n}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          让子
                          <select
                            value={options.handicap}
                            onChange={(e) =>
                              setOptions({
                                ...options,
                                handicap: Number(e.target.value),
                              })
                            }
                          >
                            {[0, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                              <option key={n}>{n}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          贴目
                          <input
                            type="number"
                            step="0.5"
                            value={options.komi}
                            onChange={(e) =>
                              setOptions({
                                ...options,
                                komi: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label>
                          规则
                          <select
                            value={options.rules}
                            onChange={(e) =>
                              setOptions({ ...options, rules: e.target.value })
                            }
                          >
                            <option value="chinese">中国规则</option>
                            <option value="japanese">日本规则</option>
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={options.training}
                      onChange={(e) =>
                        setOptions({ ...options, training: e.target.checked })
                      }
                    />
                    训练模式：保留复盘提示区域
                  </label>
                  <p>
                    本地使用当前配置；智子云和 SSH
                    需先连接对应引擎。对局期间暂停复盘分析，远端保留自身配置。人类风格档位不是平台段位认证。
                  </p>
                  <button
                    disabled={busy || disabled}
                    onClick={() =>
                      void run(async () => {
                        await controller.start(options);
                        setShow(false);
                      })
                    }
                  >
                    开始对弈
                  </button>
                </>
              )}
              {error && <p role="alert">{error}</p>}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
