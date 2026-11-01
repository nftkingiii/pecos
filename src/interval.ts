/** ERCOT delivery time: Central Prevailing Time, hour ending 1-24, 15-minute intervals 1-4. */
export interface DeliveryInterval {
  deliveryDate: string;
  deliveryHour: number;
  deliveryInterval: number;
}

const central = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function toDeliveryInterval(start: Date): DeliveryInterval {
  const parts = central.formatToParts(start);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    deliveryDate: `${part("year")}-${part("month")}-${part("day")}`,
    deliveryHour: Number(part("hour")) + 1,
    deliveryInterval: Math.floor(Number(part("minute")) / 15) + 1,
  };
}

/** Parses a request time, rejecting anything that is not an explicit instant. */
export function parseInstant(value: string): Date | null {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
