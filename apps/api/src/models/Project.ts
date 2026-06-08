import { Schema, model } from "mongoose";

const ProjectSchema = new Schema(
  {
    name: { type: String, required: true },
    surveyor: String,
    srNo: String,        // Survey Record number
    dsmNo: String,       // Diagram (DSM) number
    gpNo: String,        // General Plan number
    location: String,
    tribalArea: String,
    coordinateSystem: { type: String, default: "Lo21" }, // e.g. Lo21, Lo26
    datum: { type: String, default: "WGS84" },
    scale: { type: Number, default: 1000 },
    status: {
      type: String,
      enum: ["draft", "computing", "validated", "submitted"],
      default: "draft",
    },
  },
  { timestamps: true }
);

export const Project = model("Project", ProjectSchema);
