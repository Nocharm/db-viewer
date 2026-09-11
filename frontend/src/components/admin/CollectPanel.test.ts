import { describe, expect, it } from "vitest";

import type { CollectJob } from "@/lib/api";

import { getJobStatus, getStepStates } from "./CollectPanel";

function job(stage: CollectJob["stage"], error: string | null = null): CollectJob {
  return {
    job_id: 1, mode: "full", stage, snapshot_id: null, counts: {},
    triggered_by: "admin.sys", error, created_at: "2026-09-12T00:00:00Z",
    updated_at: "2026-09-12T00:00:00Z",
  };
}

describe("getStepStates", () => {
  it("lights the steps in order of the job stage", () => {
    expect(getStepStates(null)).toEqual(["pending", "pending", "pending"]);
    expect(getStepStates(job("catalog_running"))).toEqual(["active", "pending", "pending"]);
    expect(getStepStates(job("catalog_done"))).toEqual(["done", "pending", "pending"]);
    expect(getStepStates(job("deps_running"))).toEqual(["done", "active", "pending"]);
    expect(getStepStates(job("ready"))).toEqual(["done", "done", "done"]);
    expect(getStepStates(job("failed", "boom"))).toEqual(["failed", "failed", "pending"]);
  });
});

describe("getJobStatus", () => {
  it("separates cancelled jobs from real failures", () => {
    expect(getJobStatus(job("deps_running"))).toBe("running");
    expect(getJobStatus(job("ready"))).toBe("done");
    expect(getJobStatus(job("catalog_done"))).toBe("step1");
    expect(getJobStatus(job("failed", "cancelled by admin.sys"))).toBe("cancelled");
    expect(getJobStatus(job("failed", "n8n 502"))).toBe("failed");
  });
});
