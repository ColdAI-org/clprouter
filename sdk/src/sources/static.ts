import { RouteGraph } from "../graph.js";
import type { RouteGraphData } from "../types.js";

/** Anything that can produce a route graph snapshot. */
export interface GraphSource {
  load(): Promise<RouteGraph>;
}

/** A graph from a JSON object, a JSON string, or a JSON file path. */
export class StaticJsonSource implements GraphSource {
  constructor(private readonly input: RouteGraphData | string | { file: string }) {}

  async load(): Promise<RouteGraph> {
    const i = this.input;
    let data: RouteGraphData;
    if (typeof i === "string") data = JSON.parse(i) as RouteGraphData;
    else if ("file" in i) {
      // Imported lazily so the SDK still bundles for browsers when no file source is used.
      const { readFile } = await import("node:fs/promises");
      data = JSON.parse(await readFile(i.file, "utf8")) as RouteGraphData;
    } else data = i;
    // Deep copy so overlays never mutate the caller's object.
    return new RouteGraph(structuredClone(data));
  }
}
