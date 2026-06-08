import { Schema, model, Types } from "mongoose";

const BeaconSchema = new Schema(
  {
    projectId: { type: Types.ObjectId, ref: "Project", index: true },
    name: { type: String, required: true }, // e.g. "B1", "A", "7810"
    description: { type: String, default: "12mm iron peg" },
    east: Number,
    north: Number,
    elevation: Number,
    source: {
      type: String,
      enum: ["observed", "computed", "adjusted", "fixed"],
      default: "observed",
    },
    splay: Number, // splay in metres (seen in samples: 3m)
  },
  { timestamps: true }
);

BeaconSchema.index({ projectId: 1, name: 1 }, { unique: false });

export const Beacon = model("Beacon", BeaconSchema);
