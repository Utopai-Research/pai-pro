/**
 * labelGeometry.test.ts + chipLabel.test coverage — the two pure helpers the
 * chromeless card's floating label rests on.
 *
 * The property that matters for the width cap: the row's ON-SCREEN width is
 * `layoutWidth × zoom / effectiveZoom`, so a row rendered at the cap must land
 * on the card's right edge (card width × zoom, minus the inset) at every zoom,
 * on both sides of the counter-scale floor.
 */
import { describe, expect, it } from 'vitest'
import {
  LABEL_COUNTERSCALE_FLOOR,
  LABEL_EDGE_INSET_PX,
  labelEffectiveZoom,
  labelRowMaxWidth,
} from './labelGeometry'
import { chipDisplayLabel, chipRefText } from './chipLabel'

const CARD_W = 260

/** On-screen width of a row laid out at `layoutW`, at this zoom. */
function onScreenWidth(layoutW: number, zoom: number): number {
  return (layoutW * zoom) / labelEffectiveZoom(zoom)
}

describe('labelEffectiveZoom', () => {
  it('is the identity above the floor', () => {
    expect(labelEffectiveZoom(1)).toBe(1)
    expect(labelEffectiveZoom(2.5)).toBe(2.5)
  })

  it('clamps to the floor below it', () => {
    expect(labelEffectiveZoom(0.2)).toBe(LABEL_COUNTERSCALE_FLOOR)
    expect(labelEffectiveZoom(LABEL_COUNTERSCALE_FLOOR)).toBe(LABEL_COUNTERSCALE_FLOOR)
  })
})

describe('labelRowMaxWidth', () => {
  it('pins the row to the card edge at every zoom', () => {
    for (const zoom of [0.1, 0.3, LABEL_COUNTERSCALE_FLOOR, 0.8, 1, 1.75, 4]) {
      const cap = labelRowMaxWidth(CARD_W, zoom)
      // The card is `CARD_W` flow px, so on screen it is `CARD_W × zoom`.
      expect(onScreenWidth(cap, zoom)).toBeCloseTo((CARD_W - LABEL_EDGE_INSET_PX) * zoom, 6)
    }
  })

  it('freezes the row flow width at the floor once zoom drops below it', () => {
    // Below the floor the label rides along with the card instead of growing
    // into its neighbours: the LAYOUT width stops changing.
    const atFloor = labelRowMaxWidth(CARD_W, LABEL_COUNTERSCALE_FLOOR)
    expect(labelRowMaxWidth(CARD_W, 0.2)).toBe(atFloor)
    expect(labelRowMaxWidth(CARD_W, 0.05)).toBe(atFloor)
  })

  it('scales with the card it names', () => {
    expect(labelRowMaxWidth(360, 1)).toBeGreaterThan(labelRowMaxWidth(200, 1))
  })
})

describe('chipDisplayLabel', () => {
  it('prefers a trimmed semantic name', () => {
    expect(chipDisplayLabel('  Causeway wide  ', 'image_7')).toBe('Causeway wide')
  })

  it('falls back to the @id reference when there is no usable name', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(chipDisplayLabel(empty, 'image_7')).toBe('@image_7')
    }
  })

  it('mints the reference key in one place', () => {
    expect(chipRefText('video_2')).toBe('@video_2')
  })
})
