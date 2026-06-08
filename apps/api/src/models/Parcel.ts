import { Schema, model, Types } from "mongoose";

const SideSchema = new Schema(
  { from: String, to: String, distance: Number, bearing: String },
  { _id: false }
);

const ParcelSchema = new Schema(
  {
    projectId: { type: Types.ObjectId, ref: "Project", index: true },
    lotNumber: { type: String, required: true },
    cadastre: String,
    type: {
      type: String,
      enum: ["lot", "road", "servitude", "remainder", "pedway"],
      default: "lot",
    },
    beaconNames: [String],   // ordered boundary beacons
    sides: [SideSchema],
    areaM2: Number,
    areaHa: Number,
    parentParcelId: { type: Types.ObjectId, ref: "Parcel" },
    status: {
      type: String,
      enum: ["draft", "verified", "flagged"],
      default: "draft",
    },
  },
  { timestamps: true }
);

export const Parcel = model("Parcel", ParcelSchema);
