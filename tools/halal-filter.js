// Sharia compliance pre-filter for token screening.
// Blocks tokens whose narrative or social links describe haram business models.
// Signals checked: Jupiter ChainInsight narrative + twitter/website from token info.
// Name/symbol are intentionally NOT checked — too many false positives.

const HARAM = [
  // Adult content
  { pat: /hentai/i,                          cat: "adult" },
  { pat: /porn(?:ograph)?/i,                 cat: "adult" },
  { pat: /\bnsfw\b/i,                        cat: "adult" },
  { pat: /\berotic\b/i,                      cat: "adult" },
  { pat: /adult content/i,                   cat: "adult" },
  { pat: /onlyfans?/i,                       cat: "adult" },
  { pat: /strip(?:tease|club)/i,             cat: "adult" },

  // Gambling — context-anchored to avoid standalone "lottery" false positives
  { pat: /\bcasino\b/i,                      cat: "gambling" },
  { pat: /gambl(?:ing|e)/i,                  cat: "gambling" },
  { pat: /\bgacha\b/i,                       cat: "gambling" },
  { pat: /\braffle\b/i,                      cat: "gambling" },
  { pat: /fees\b.{0,40}lottery/i,            cat: "gambling" },
  { pat: /lottery\b.{0,30}draws?/i,          cat: "gambling" },
  { pat: /hourly lottery/i,                  cat: "gambling" },
  { pat: /holders?.{0,40}lottery draws?/i,   cat: "gambling" },

  // Gharar (prohibited speculation — derivatives, leverage, perpetuals)
  { pat: /perpetual.{0,50}(?:futures?|contract|swap|exchange)/i, cat: "gharar" },
  { pat: /\bperps?\s+(?:exchange|platform|trading)/i,            cat: "gharar" },
  { pat: /synthetic\s+(?:long|short)/i,                          cat: "gharar" },
  { pat: /\d+[×x]\s*leverage/i,                                  cat: "gharar" },
  { pat: /leveraged?\s+position/i,                               cat: "gharar" },

  // Riba (interest-based lending)
  { pat: /lending protocol/i,                cat: "riba" },
  { pat: /borrow.{0,20}interest/i,           cat: "riba" },
  { pat: /interest[- ]bearing/i,             cat: "riba" },
  { pat: /flash loan/i,                      cat: "riba" },
  { pat: /over[- ]collateral/i,              cat: "riba" },

  // Drugs
  { pat: /420 cannabis/i,                    cat: "drugs" },
  { pat: /cannabis culture/i,                cat: "drugs" },
  { pat: /\bmarijuana\b/i,                   cat: "drugs" },
];

/**
 * @param {{ narrative?: string|null, twitter?: string|null, website?: string|null }} signals
 * @returns {{ blocked: boolean, category?: string, pattern?: string }}
 */
export function checkHalal({ narrative, twitter, website }) {
  const text = [narrative, twitter, website].filter(Boolean).join(" ");
  for (const { pat, cat } of HARAM) {
    if (pat.test(text)) {
      return { blocked: true, category: cat, pattern: pat.source };
    }
  }
  return { blocked: false };
}
