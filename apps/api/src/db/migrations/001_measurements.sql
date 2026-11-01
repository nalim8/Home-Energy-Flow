-- Leistungsmesswerte in Watt, Vorzeichenkonvention wie im Domain-Modell:
-- battery_power_w > 0 = Laden, grid_power_w ist ein Betrag mit grid_direction.
CREATE TABLE measurements (
  id                  BIGSERIAL PRIMARY KEY,
  measured_at         TIMESTAMPTZ      NOT NULL,
  source              TEXT             NOT NULL CHECK (source IN ('sungrow-cloud', 'sungrow-modbus', 'demo')),
  pv_power_w          DOUBLE PRECISION NOT NULL CHECK (pv_power_w >= 0),
  household_power_w   DOUBLE PRECISION NOT NULL CHECK (household_power_w >= 0),
  battery_power_w     DOUBLE PRECISION NOT NULL,
  battery_soc_percent DOUBLE PRECISION NOT NULL CHECK (battery_soc_percent BETWEEN 0 AND 100),
  grid_power_w        DOUBLE PRECISION NOT NULL CHECK (grid_power_w >= 0),
  grid_direction      TEXT             NOT NULL CHECK (grid_direction IN ('import', 'export', 'idle')),
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
  UNIQUE (source, measured_at)
);

CREATE INDEX measurements_measured_at_idx ON measurements (measured_at);
