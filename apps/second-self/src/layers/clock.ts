/**
 * Clock overlay: concentric hour/minute/second/millisecond arcs.
 *
 * Ports the legacy `clock` app (display.js), scaled up for the portrait mirror
 * and anchored in the top-right corner.
 */

import type { LayerDeps } from '../shared/deps.js';
import { REF_WIDTH, type Layer } from '../shared/types.js';

const R = 90;
const EC = 14;
const CENTER_X = REF_WIDTH - 180;
const CENTER_Y = 200;

export function createClockLayer(_deps: LayerDeps): Layer {
  return {
    render({ ctx }): void {
      const now = new Date();
      const h = now.getHours() % 12;
      const min = now.getMinutes();
      const sec = now.getSeconds();
      const milli = now.getMilliseconds();

      ctx.save();
      ctx.translate(CENTER_X, CENTER_Y);
      ctx.rotate(-Math.PI / 2);
      ctx.lineWidth = 3;

      arcAndHand(ctx, R, (h / 12) * 360, 'rgb(76,0,153)', R * 0.4);
      arcAndHand(ctx, R + EC / 2, (min / 60) * 360, 'rgb(200,200,0)', R * 0.6);
      arcAndHand(ctx, R + EC, (sec / 60) * 360, 'rgb(50,150,255)', R * 0.8);
      arcAndHand(ctx, R + (3 * EC) / 2, (milli / 1000) * 360, 'rgb(100,255,200)', null);

      ctx.restore();
    },
  };
}

function arcAndHand(
  ctx: CanvasRenderingContext2D,
  radius: number,
  degrees: number,
  color: string,
  handLength: number | null,
): void {
  const end = (degrees * Math.PI) / 180;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, end);
  ctx.stroke();

  if (handLength !== null) {
    ctx.save();
    ctx.rotate(end);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(handLength, 0);
    ctx.stroke();
    ctx.restore();
  }
}
