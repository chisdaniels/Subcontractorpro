// Vercel Edge serverless function that renders a 1200x630 PNG for social
// previews. Meta tags in index.html point at /api/og so iMessage,
// Slack, LinkedIn, X, Facebook, WhatsApp etc. all get a real raster
// image instead of the SVG (which iMessage silently drops).
import { ImageResponse } from "@vercel/og";
import React from "react";

export const config = { runtime: "edge" };

export default function handler() {
  return new ImageResponse(
    React.createElement(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "80px",
          background: "linear-gradient(180deg, #0f172a 0%, #020617 100%)",
          fontFamily: "system-ui, sans-serif",
        },
      },
      // Wordmark
      React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column" } },
        React.createElement(
          "div",
          {
            style: {
              fontSize: 108,
              fontWeight: 900,
              letterSpacing: 4,
              color: "#f59e0b",
              lineHeight: 1,
            },
          },
          "SUBCONTRACTOR"
        ),
        React.createElement(
          "div",
          {
            style: {
              fontSize: 108,
              fontWeight: 900,
              letterSpacing: 4,
              color: "#f59e0b",
              lineHeight: 1,
              marginTop: 10,
            },
          },
          "PROS"
        )
      ),
      // Middle tagline
      React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column" } },
        React.createElement(
          "div",
          {
            style: {
              fontSize: 44,
              color: "#f1f5f9",
              fontWeight: 600,
              marginBottom: 14,
            },
          },
          "Post a job. Get matched with verified pros."
        ),
        React.createElement(
          "div",
          {
            style: {
              fontSize: 28,
              color: "#94a3b8",
            },
          },
          "Every contractor's license & insurance vetted before they can accept work."
        )
      ),
      // Feature badges
      React.createElement(
        "div",
        { style: { display: "flex", gap: 16 } },
        badge("VERIFIED PROS", "#10b981", "rgba(16,185,129,0.15)"),
        badge("FREE TO POST", "#f59e0b", "rgba(245,158,11,0.15)"),
        badge("LICENSED & INSURED", "#3b82f6", "rgba(59,130,246,0.15)")
      )
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}

function badge(text, borderColor, bg) {
  return React.createElement(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "12px 24px",
        borderRadius: 999,
        border: `3px solid ${borderColor}`,
        background: bg,
        color: borderColor,
        fontSize: 22,
        fontWeight: 700,
        letterSpacing: 1,
      },
    },
    text
  );
}
