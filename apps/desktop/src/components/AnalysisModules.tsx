import { useId, useState, type ComponentProps } from "react";
import { WinrateChart } from "./WinrateChart";
import "./AnalysisModules.css";
import { ReviewDashboard } from "./ReviewDashboard";
import type { ReviewScope } from "../domain/reviewStatistics";

const modules = [
  ["summary", "测评"],
  ["match", "吻合度"],
  ["winrate", "走势"],
  ["mistakes", "问题手"],
  ["performance", "发挥水准"],
] as const;
type Module = (typeof modules)[number][0];

export function AnalysisModules(
  props: ComponentProps<typeof WinrateChart> & {
    statistics?: ReviewScope;
    onNodeSelect?: (id: string) => void;
  },
) {
  const [active, setActive] = useState<Module>("winrate");
  const id = useId();
  const label = modules.find(([key]) => key === active)![1];
  return (
    <div className="analysis-modules">
      <div
        className="analysis-module-tabs"
        role="tablist"
        aria-label="分析模块"
      >
        {modules.map(([key, title], index) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${id}-${key}`}
            aria-selected={active === key}
            aria-controls={`${id}-panel`}
            tabIndex={active === key ? 0 : -1}
            onClick={() => setActive(key)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight")
                next = (index + 1) % modules.length;
              else if (event.key === "ArrowLeft")
                next = (index + modules.length - 1) % modules.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = modules.length - 1;
              else return;
              event.preventDefault();
              setActive(modules[next][0]);
              document.getElementById(`${id}-${modules[next][0]}`)?.focus();
            }}
          >
            {title}
          </button>
        ))}
      </div>
      <div
        className="analysis-module-content"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${active}`}
        tabIndex={0}
      >
        {active === "winrate" ? (
          <WinrateChart {...props} />
        ) : props.statistics ? (
          <ReviewDashboard
            scope={props.statistics}
            mode={active}
            onNodeSelect={props.onNodeSelect}
            onMoveSelect={props.onMoveSelect}
          />
        ) : (
          <div className="analysis-module-empty">
            <span>{label}</span>
            <small>模块待加入</small>
          </div>
        )}
      </div>
    </div>
  );
}
