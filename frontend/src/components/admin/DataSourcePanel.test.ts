import { describe, expect, it } from "vitest";

import {
  buildCreateInput,
  buildUpdateInput,
  isSourceFormValid,
  type SourceFormState,
} from "./DataSourcePanel";

const POSTGRES_FORM: SourceFormState = {
  name: "  service-b  ", engine: "postgres", host: " db.internal ", port: 5432,
  database: " billing ", username: " ro_user ", password: "", file_path: "",
};

const SQLITE_FORM: SourceFormState = {
  name: "svc-c", engine: "sqlite", host: "", port: 5432,
  database: "", username: "", password: "", file_path: " /mnt/sources/svcc/app.db ",
};

describe("isSourceFormValid", () => {
  it("requires host/port/database/username for postgres", () => {
    expect(isSourceFormValid(POSTGRES_FORM)).toBe(true);
    expect(isSourceFormValid({ ...POSTGRES_FORM, host: "" })).toBe(false);
    expect(isSourceFormValid({ ...POSTGRES_FORM, database: "" })).toBe(false);
    expect(isSourceFormValid({ ...POSTGRES_FORM, username: "" })).toBe(false);
    expect(isSourceFormValid({ ...POSTGRES_FORM, port: 0 })).toBe(false);
  });

  it("requires only file_path for sqlite", () => {
    expect(isSourceFormValid(SQLITE_FORM)).toBe(true);
    expect(isSourceFormValid({ ...SQLITE_FORM, file_path: "  " })).toBe(false);
  });

  it("always requires a name", () => {
    expect(isSourceFormValid({ ...POSTGRES_FORM, name: "  " })).toBe(false);
    expect(isSourceFormValid({ ...SQLITE_FORM, name: "" })).toBe(false);
  });
});

describe("buildCreateInput", () => {
  it("trims postgres fields and includes engine-specific keys only", () => {
    expect(buildCreateInput(POSTGRES_FORM)).toEqual({
      name: "service-b", engine: "postgres",
      host: "db.internal", port: 5432, database: "billing", username: "ro_user",
    });
  });

  it("includes password only when the field is filled in", () => {
    expect(buildCreateInput({ ...POSTGRES_FORM, password: "s3cret" })).toEqual({
      name: "service-b", engine: "postgres",
      host: "db.internal", port: 5432, database: "billing", username: "ro_user",
      password: "s3cret",
    });
  });

  it("sends only file_path for sqlite, no postgres fields", () => {
    expect(buildCreateInput(SQLITE_FORM)).toEqual({
      name: "svc-c", engine: "sqlite", file_path: "/mnt/sources/svcc/app.db",
    });
  });
});

describe("buildUpdateInput", () => {
  it("omits engine — the backend does not accept it on update", () => {
    const payload = buildUpdateInput(POSTGRES_FORM);
    expect(payload).not.toHaveProperty("engine");
    expect(payload).toEqual({
      name: "service-b", host: "db.internal", port: 5432,
      database: "billing", username: "ro_user",
    });
  });

  it("leaves password out when the edit field is blank (means unchanged)", () => {
    expect(buildUpdateInput(SQLITE_FORM)).toEqual({
      name: "svc-c", file_path: "/mnt/sources/svcc/app.db",
    });
  });

  it("includes password when the edit field is filled in (means replace)", () => {
    const payload = buildUpdateInput({ ...SQLITE_FORM, password: "new-pw" });
    expect(payload.password).toBe("new-pw");
  });
});
