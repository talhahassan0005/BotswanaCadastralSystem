import { Schema, model, Types } from "mongoose";

const ObservationSchema = new Schema(
  {
    projectId: { type: Types.ObjectId, ref: "Project", index: true },
    order: Number,
    fromBeacon: String,
    toBeacon: String,
    bearing: String,    // stored as text in original notation (e.g. "272.36.20")
    distance: Number,   // metres
    stddev: Number,
    instrument: String,
  },
  { timestamps: true }
);

export const Observation = model("Observation", ObservationSchema);
