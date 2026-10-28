import { describe, expect, it, vi } from "vitest";

import { fetchDayWeather, weatherLabel } from "./weather.js";

// Open-Meteo's answer to a date outside its forecast range, with status 400.
const OUT_OF_RANGE = { error: true, reason: "Parameter 'start_date' is out of allowed range from 2026-08-11 to 2026-11-12" };

// A recorded response from
// https://api.open-meteo.com/v1/forecast?latitude=47.6&longitude=-122.3&daily=weather_code&timezone=auto&start_date=2026-10-27&end_date=2026-10-27
const RECORDED = {
    latitude: 47.6,
    longitude: -122.3,
    timezone: "America/Los_Angeles",
    daily_units: { time: "iso8601", weather_code: "wmo code" },
    daily: { time: ["2026-10-27"], weather_code: [61] }
};

const respond = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

describe("fetchDayWeather", () => {
    it("asks Open-Meteo for the planned date's weather code and returns it with a label", async () => {
        const fetcher = respond(RECORDED);

        expect(await fetchDayWeather(47.6, -122.3, "2026-10-27", fetcher)).toEqual({ code: 61, label: "Rain" });

        const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe("https://api.open-meteo.com/v1/forecast");
        expect(Object.fromEntries(parsed.searchParams)).toEqual({
            latitude: "47.6", longitude: "-122.3", daily: "weather_code", timezone: "auto", start_date: "2026-10-27", end_date: "2026-10-27"
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("returns undefined on a failure: a date out of the forecast's range, network error, bad status, odd body or timeout", async () => {
        const day = "2026-10-27";
        expect(await fetchDayWeather(1, 2, "2027-03-01", respond(OUT_OF_RANGE, false))).toBeUndefined();
        expect(await fetchDayWeather(1, 2, "2026-10-28", respond(RECORDED))).toBeUndefined();
        expect(await fetchDayWeather(1, 2, day, vi.fn(async () => { throw new Error("offline"); }))).toBeUndefined();
        expect(await fetchDayWeather(1, 2, day, respond({}, false))).toBeUndefined();
        expect(await fetchDayWeather(1, 2, day, respond({ daily: { weather_code: [] } }))).toBeUndefined();
        expect(await fetchDayWeather(1, 2, day, respond({ daily: { time: [ day ], weather_code: ["x"] } }))).toBeUndefined();
        expect(await fetchDayWeather(1, 2, day, respond(null))).toBeUndefined();

        vi.useFakeTimers();
        try {
            const hung = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
                init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }));
            const pending = fetchDayWeather(1, 2, day, hung as unknown as typeof fetch);
            await vi.advanceTimersByTimeAsync(3000);
            expect(await pending).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("weatherLabel", () => {
    it("names the WMO codes", () => {
        expect(weatherLabel(0)).toBe("Clear");
        expect(weatherLabel(2)).toBe("Partly cloudy");
        expect(weatherLabel(3)).toBe("Overcast");
        expect(weatherLabel(45)).toBe("Fog");
        expect(weatherLabel(53)).toBe("Drizzle");
        expect(weatherLabel(65)).toBe("Rain");
        expect(weatherLabel(75)).toBe("Snow");
        expect(weatherLabel(81)).toBe("Showers");
        expect(weatherLabel(96)).toBe("Thunderstorm");
        expect(weatherLabel(123)).toBe("Cloudy");
    });
});
