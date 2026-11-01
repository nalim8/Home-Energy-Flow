import type { EnergySnapshot, FreshnessStatus } from "@hef/energy-domain";
import { formatPower } from "../format";
import { Icon, type IconName } from "./Icon";

/** Unterhalb dieser Leistung wird eine Leitung als inaktiv gezeichnet */
const ACTIVE_THRESHOLD_W = 20;

const HUB = { x: 200, y: 204 };
const NODE_R = 42;

interface NodeSpec {
  key: "pv" | "grid" | "house" | "battery";
  label: string;
  icon: IconName;
  color: string;
  x: number;
  y: number;
  /** Position der Beschriftung relativ zum Knoten */
  labelSide: "top" | "bottom";
}

const NODES: NodeSpec[] = [
  { key: "pv", label: "PV-Anlage", icon: "sun", color: "var(--c-pv)", x: 200, y: 86, labelSide: "top" },
  { key: "grid", label: "Stromnetz", icon: "grid", color: "var(--c-grid)", x: 58, y: 204, labelSide: "bottom" },
  { key: "house", label: "Haus", icon: "house", color: "var(--c-house)", x: 342, y: 204, labelSide: "bottom" },
  { key: "battery", label: "Speicher", icon: "battery", color: "var(--c-battery)", x: 200, y: 322, labelSide: "bottom" },
];

interface Line {
  powerW: number;
  /** true: Energie fließt vom Knoten zum Wechselrichter */
  towardHub: boolean;
  detail: string;
}

function linesFor(s: EnergySnapshot): Record<NodeSpec["key"], Line> {
  const battery = s.batteryPowerW;
  return {
    pv: { powerW: s.pvPowerW, towardHub: true, detail: s.pvPowerW >= ACTIVE_THRESHOLD_W ? "Erzeugung" : "keine Erzeugung" },
    house: { powerW: s.householdPowerW, towardHub: false, detail: "Verbrauch" },
    battery: {
      powerW: Math.abs(battery),
      towardHub: battery < 0,
      detail:
        battery >= ACTIVE_THRESHOLD_W ? "lädt" : battery <= -ACTIVE_THRESHOLD_W ? "entlädt" : "Ruhe",
    },
    grid: {
      powerW: s.gridPowerW,
      towardHub: s.gridDirection === "import",
      detail: s.gridDirection === "import" ? "Bezug" : s.gridDirection === "export" ? "Einspeisung" : "neutral",
    },
  };
}

/** Animationsdauer eines Strichmusters: je höher die Leistung, desto schneller */
const durationFor = (watts: number) => Math.max(0.5, Math.min(3, 3 - Math.log10(Math.max(1, watts / 100)) * 1.2));

interface Props {
  snapshot: EnergySnapshot | null;
  status: FreshnessStatus;
}

export function EnergyFlow({ snapshot, status }: Props) {
  const lines = snapshot ? linesFor(snapshot) : null;
  // Veraltete Werte werden gezeigt, aber nicht animiert – sonst wirkt alter Stand wie live
  const animate = status === "live";

  const description = lines
    ? NODES.map((n) => `${n.label}: ${formatPower(lines[n.key].powerW)} (${lines[n.key].detail})`).join(", ")
    : "Keine Messwerte verfügbar";

  return (
    <svg className={`energy-flow ${animate ? "" : "is-paused"}`} viewBox="0 0 400 408" role="img" aria-label={`Energiefluss. ${description}`}>
      {NODES.map((node) => {
        const line = lines?.[node.key];
        const active = line !== undefined && line.powerW >= ACTIVE_THRESHOLD_W;
        // Pfad läuft immer vom Knoten zum Wechselrichter; die Richtung steuert die Animation
        const dx = HUB.x - node.x;
        const dy = HUB.y - node.y;
        const len = Math.hypot(dx, dy);
        const ux = dx / len;
        const uy = dy / len;
        const d = `M${node.x + ux * (NODE_R + 4)},${node.y + uy * (NODE_R + 4)}L${HUB.x - ux * 22},${HUB.y - uy * 22}`;
        return (
          <g key={node.key}>
            <path className="flow-track" d={d} />
            {active && (
              <path
                className={`flow-dash ${line.towardHub ? "" : "is-reverse"}`}
                d={d}
                stroke={node.color}
                strokeWidth={2 + Math.min(4, line.powerW / 1500)}
                style={{ animationDuration: `${durationFor(line.powerW)}s` }}
              />
            )}
          </g>
        );
      })}

      <g className="hub">
        <rect x={HUB.x - 20} y={HUB.y - 20} width={40} height={40} rx={10} />
        <g transform={`translate(${HUB.x - 11} ${HUB.y - 11})`}>
          <Icon name="inverter" size={22} />
        </g>
      </g>

      {NODES.map((node) => {
        const line = lines?.[node.key];
        const labelY = node.labelSide === "top" ? node.y - NODE_R - 24 : node.y + NODE_R + 18;
        return (
          <g key={node.key} className="flow-node">
            <circle cx={node.x} cy={node.y} r={NODE_R} stroke={node.color} />
            <g transform={`translate(${node.x - 13} ${node.y - 22})`} style={{ color: node.color }}>
              <Icon name={node.icon} size={26} />
            </g>
            {node.key === "battery" && snapshot && (
              <text className="node-soc" x={node.x} y={node.y + 20} textAnchor="middle">
                {Math.round(snapshot.batterySocPercent)} %
              </text>
            )}
            {node.key !== "battery" && (
              <text className="node-value" x={node.x} y={node.y + 20} textAnchor="middle">
                {line ? formatPower(line.powerW) : "–"}
              </text>
            )}
            <text className="node-label" x={node.x} y={labelY} textAnchor="middle">
              {node.label}
            </text>
            <text className="node-detail" x={node.x} y={labelY + 15} textAnchor="middle">
              {node.key === "battery" && line ? `${formatPower(line.powerW)} · ${line.detail}` : (line?.detail ?? "")}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
