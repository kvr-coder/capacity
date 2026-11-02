/**
 * Dataset profiles and the fixed physical facts of the network.
 *
 * A `Profile` is the only input to `buildSnapshot`. Everything else in the
 * generated world — plants, features, machine classes, standard operations — is
 * a constant declared here, so the shape of the network never depends on the
 * PRNG and only its *population* does. That split matters: a planner comparing
 * the `demo` and `standard` profiles is looking at the same five plants, the
 * same twelve machine classes and the same eighteen operations, just more of
 * everything.
 *
 * Nothing in this file imports anything above `src/domain`, and nothing in it
 * is random, so it is safe to read from the worker, from a Node script, or from
 * a test.
 */

import type {
  Currency,
  FamilyId,
  Feature,
  MachineClass,
  OperationId,
  PlantId,
  Region,
  StandardOperation,
} from '@/domain/types'

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface Profile {
  id: string
  label: string
  skuCount: number
  workCenterCount: number
  weekCount: number
  /** ISO Monday the horizon starts on. Snapped to its own ISO week if it is not. */
  startMonday: string
  seed: number
}

/**
 * Three sizes of the same world.
 *
 * `demo` exists so tests and the first paint stay fast; `standard` is the
 * contracted 15,000 SKU / 150 work center / 78 week network; `large` is the
 * stress profile that proves the worker budget holds when the network grows.
 * The seed differs per profile so the three are visibly different datasets
 * rather than a prefix of one another.
 */
export const PROFILES: Profile[] = [
  {
    id: 'demo',
    label: 'Demo — 1.5k SKUs, 40 work centers',
    skuCount: 1500,
    workCenterCount: 40,
    weekCount: 78,
    startMonday: '2026-01-05',
    seed: 20260105,
  },
  {
    id: 'standard',
    label: 'Standard — 15k SKUs, 150 work centers',
    skuCount: 15000,
    workCenterCount: 150,
    weekCount: 78,
    startMonday: '2026-01-05',
    seed: 71042311,
  },
  {
    id: 'large',
    label: 'Large — 30k SKUs, 240 work centers',
    skuCount: 30000,
    workCenterCount: 240,
    weekCount: 78,
    startMonday: '2026-01-05',
    seed: 90881457,
  },
]

export const DEFAULT_PROFILE = 'standard'

/** Look a profile up by id. Falls back to the default rather than throwing. */
export function profileById(id: string): Profile {
  for (const profile of PROFILES) if (profile.id === id) return profile
  for (const profile of PROFILES) if (profile.id === DEFAULT_PROFILE) return profile
  throw new Error(`no profiles declared`)
}

// ---------------------------------------------------------------------------
// The five plants
// ---------------------------------------------------------------------------

/**
 * Everything about a plant that is a fact rather than a generated number.
 * `colorSlot` is permanent: colour follows the entity for the life of the app,
 * so filtering to three plants never repaints the survivors.
 */
export interface PlantSpec {
  id: PlantId
  code: string
  name: string
  city: string
  country: string
  countryCode: string
  region: Region
  currency: Currency
  fxPerUsd: number
  timezone: string
  lat: number
  lon: number
  colorSlot: 1 | 2 | 3 | 4 | 5
  labourCostPerHourLocal: number
  defaultOee: number
  gridIntensity: number
  /** Roughly how many of the profile's work centers live here. */
  workCenterWeight: number
  /**
   * Hours in one shift. 7.5 at DE-ING is not a rounding choice — the German
   * works council agreement is a 37.5 hour week across five shifts, and using
   * 8 there would manufacture ~6% of capacity that does not exist.
   */
  hoursPerShift: number
}

export const PLANT_SPECS: PlantSpec[] = [
  {
    id: 'US-TOL',
    code: 'US-TOL',
    name: 'Toledo Components',
    city: 'Toledo, Ohio',
    country: 'United States',
    countryCode: 'US',
    region: 'NAM',
    currency: 'USD',
    fxPerUsd: 1,
    timezone: 'America/New_York',
    lat: 41.65,
    lon: -83.54,
    colorSlot: 1,
    labourCostPerHourLocal: 58,
    defaultOee: 0.84,
    gridIntensity: 0.38,
    workCenterWeight: 30,
    hoursPerShift: 8,
  },
  {
    id: 'MX-SLP',
    code: 'MX-SLP',
    name: 'San Luis Potosi Moulding',
    city: 'San Luis Potosi',
    country: 'Mexico',
    countryCode: 'MX',
    region: 'NAM',
    currency: 'MXN',
    fxPerUsd: 17.2,
    timezone: 'America/Mexico_City',
    lat: 22.16,
    lon: -100.98,
    colorSlot: 2,
    labourCostPerHourLocal: 210,
    defaultOee: 0.76,
    gridIntensity: 0.42,
    workCenterWeight: 28,
    hoursPerShift: 8,
  },
  {
    id: 'DE-ING',
    code: 'DE-ING',
    name: 'Ingolstadt Präzision',
    city: 'Ingolstadt',
    country: 'Germany',
    countryCode: 'DE',
    region: 'EUR',
    currency: 'EUR',
    fxPerUsd: 0.92,
    timezone: 'Europe/Berlin',
    lat: 48.76,
    lon: 11.42,
    colorSlot: 3,
    labourCostPerHourLocal: 52,
    defaultOee: 0.86,
    gridIntensity: 0.33,
    workCenterWeight: 26,
    // Works-council hours: 37.5h week, five 7.5h shifts. iOS/other plants run 8.
    hoursPerShift: 7.5,
  },
  {
    id: 'PL-WRO',
    code: 'PL-WRO',
    name: 'Wrocław Systems',
    city: 'Wrocław',
    country: 'Poland',
    countryCode: 'PL',
    region: 'EUR',
    currency: 'PLN',
    fxPerUsd: 3.95,
    timezone: 'Europe/Warsaw',
    lat: 51.11,
    lon: 17.04,
    colorSlot: 4,
    labourCostPerHourLocal: 95,
    defaultOee: 0.79,
    gridIntensity: 0.66,
    workCenterWeight: 31,
    hoursPerShift: 8,
  },
  {
    id: 'CN-SUZ',
    code: 'CN-SUZ',
    name: 'Suzhou Precision',
    city: 'Suzhou',
    country: 'China',
    countryCode: 'CN',
    region: 'APAC',
    currency: 'CNY',
    fxPerUsd: 7.15,
    timezone: 'Asia/Shanghai',
    lat: 31.3,
    lon: 120.58,
    colorSlot: 5,
    labourCostPerHourLocal: 62,
    defaultOee: 0.78,
    gridIntensity: 0.58,
    workCenterWeight: 35,
    hoursPerShift: 8,
  },
]

/**
 * The strategic sentence a planner needs before they read a single number. The
 * network only makes sense if you know why each site exists — moving work from
 * the flagship to the cost play is a different conversation from moving it to
 * the plant that owns the customer.
 */
export const PLANT_META: Record<PlantId, { flag: string; blurb: string; role: string }> = {
  'US-TOL': {
    flag: '🇺🇸',
    role: 'the incumbent',
    blurb:
      'The incumbent. Oldest asset base, deepest approvals, and the only site qualified for the North American automotive accounts. Expensive per hour, but nothing ships late.',
  },
  'MX-SLP': {
    flag: '🇲🇽',
    role: 'the NAM cost play',
    blurb:
      'The NAM cost play. Low labour cost and a young asset base, held back by OEE and a thin approval list — most of what it could run, nobody has qualified it to run.',
  },
  'DE-ING': {
    flag: '🇩🇪',
    role: 'the flagship',
    blurb:
      'The flagship. Highest OEE, tightest tolerances, the cleanest grid in the network. Works-council hours cap the week at 37.5, so capacity here is bought in shifts, never in overtime.',
  },
  'PL-WRO': {
    flag: '🇵🇱',
    role: 'the European swing plant',
    blurb:
      'The European swing plant. Broad capability, mid-cost, and the site an OEE programme is currently pointed at. Where German overflow lands when Ingolstadt runs out of hours.',
  },
  'CN-SUZ': {
    flag: '🇨🇳',
    role: 'the volume engine',
    blurb:
      'The volume engine. Largest work-center count and the widest routing coverage, offset by the dirtiest grid in the network — every hour moved here trades cost against CO2.',
  },
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function feature(id: string, name: string, group: Feature['group'], description: string): Feature {
  return { id, name, group, description }
}

/** ~26 capabilities, across the five groups the contract declares. */
export const FEATURES: Feature[] = [
  // process
  feature('MOLD', 'Injection moulding', 'process', 'Thermoplastic injection moulding cell.'),
  feature('PAINT', 'Paint application', 'process', 'Automated spray or powder application booth.'),
  feature('CURE', 'Cure oven', 'process', 'Thermal cure tunnel downstream of paint or adhesive.'),
  feature('ASSEMBLE', 'Assembly', 'process', 'Multi-part mechanical assembly station.'),
  feature('WELD', 'Ultrasonic welding', 'process', 'Ultrasonic or hot-plate joining of mouldings.'),
  feature('MACHINE_CNC', 'CNC machining', 'process', '3-axis trimming and feature machining.'),
  feature('PACK', 'Packing', 'process', 'Cartoning and handling-unit build.'),
  feature('LABEL', 'Labelling', 'process', 'Print-and-apply label station with verification.'),
  // quality
  feature('TOL_A', 'Tolerance class A', 'quality', 'Holds ±0.05 mm on critical dimensions.'),
  feature('TOL_B', 'Tolerance class B', 'quality', 'Holds ±0.15 mm on critical dimensions.'),
  feature('TOL_C', 'Tolerance class C', 'quality', 'Holds ±0.40 mm — general-purpose tolerance.'),
  feature('VISION_INSPECT', 'Vision inspection', 'quality', 'Camera-based 100% surface and feature inspection.'),
  feature('LEAK_TEST', 'Leak test', 'quality', 'Pressure-decay leak test rig.'),
  feature('FUNCTION_TEST', 'Function test', 'quality', 'End-of-line electrical and mechanical function test.'),
  // material
  feature('RESIN_STD', 'Standard resin', 'material', 'PP, ABS and PC-ABS grades.'),
  feature('RESIN_GF', 'Glass-filled resin', 'material', 'Abrasive glass-filled grades; hardened screws and tooling.'),
  feature('RESIN_HT', 'High-temp resin', 'material', 'PPS, PEEK and other high-temperature grades.'),
  feature('METAL_AL', 'Aluminium inserts', 'material', 'Aluminium insert handling and over-moulding.'),
  feature('METAL_STEEL', 'Steel inserts', 'material', 'Steel insert handling and over-moulding.'),
  // handling
  feature('CAV_2', '2-cavity tooling', 'handling', 'Tool clamp and hot-runner support for 2 cavities.'),
  feature('CAV_4', '4-cavity tooling', 'handling', 'Tool clamp and hot-runner support for 4 cavities.'),
  feature('CAV_8', '8-cavity tooling', 'handling', 'Tool clamp and hot-runner support for 8 cavities.'),
  feature('ROBOT_LOAD', 'Robot load/unload', 'handling', 'Six-axis robot part handling; runs unattended.'),
  feature('AUTO_EJECT', 'Automatic ejection', 'handling', 'Servo ejection and conveyor take-away.'),
  // compliance
  feature('CLEANROOM', 'Cleanroom', 'compliance', 'ISO Class 8 enclosure with monitored particulate.'),
  feature('ESD', 'ESD control', 'compliance', 'Electrostatic-discharge protected area.'),
  feature('FOOD_GRADE', 'Food grade', 'compliance', 'Food-contact certified materials and cleaning regime.'),
]

// ---------------------------------------------------------------------------
// Machine classes
// ---------------------------------------------------------------------------

/**
 * Twelve classes, four suppliers, generations 1..4.
 *
 * The generation axis is the whole "old machine that moulds but cannot paint"
 * story. A generation-1 class carries a narrow base set and sells retrofits
 * that add real capability for real money; a generation-4 class arrives with
 * the deep set already installed and sells only marginal improvements. Reading
 * down this list is reading twenty years of capital decisions.
 */
export const MACHINE_CLASSES: MachineClass[] = [
  {
    id: 'MC-ARB-100',
    name: 'Arburg 100 Series',
    supplier: 'Arburg',
    generation: 1,
    baseFeatures: ['MOLD', 'TOL_C', 'CAV_2', 'RESIN_STD'],
    retrofits: [
      {
        id: 'RF-ARB-100-EJECT',
        name: 'Servo ejection + take-away conveyor',
        addsFeatures: ['AUTO_EJECT'],
        capexUsd: 145000,
        leadTimeWeeks: 9,
        oeeDelta: 0.03,
        description: 'Replaces hydraulic ejection; removes the operator from the drop zone.',
      },
      {
        id: 'RF-ARB-100-TOOL4',
        name: '4-cavity clamp and hot-runner upgrade',
        addsFeatures: ['CAV_4', 'TOL_B'],
        capexUsd: 420000,
        leadTimeWeeks: 18,
        oeeDelta: 0.02,
        description: 'Larger platen, sequential hot-runner control. Doubles shots per cycle.',
      },
      {
        id: 'RF-ARB-100-ROBOT',
        name: 'Six-axis robot cell',
        addsFeatures: ['ROBOT_LOAD', 'AUTO_EJECT'],
        capexUsd: 610000,
        leadTimeWeeks: 22,
        oeeDelta: 0.05,
        description: 'Robot, guarding and safety rework. The unattended-running conversion.',
      },
    ],
  },
  {
    id: 'MC-ARB-250',
    name: 'Arburg 250 Series',
    supplier: 'Arburg',
    generation: 2,
    baseFeatures: ['MOLD', 'TOL_B', 'TOL_C', 'CAV_2', 'CAV_4', 'RESIN_STD', 'AUTO_EJECT'],
    retrofits: [
      {
        id: 'RF-ARB-250-GF',
        name: 'Glass-filled resin package',
        addsFeatures: ['RESIN_GF'],
        capexUsd: 180000,
        leadTimeWeeks: 12,
        oeeDelta: -0.01,
        description: 'Hardened screw, barrel and tool faces. Abrasive grades wear a standard barrel out in months.',
      },
      {
        id: 'RF-ARB-250-VISION',
        name: 'In-cell vision inspection',
        addsFeatures: ['VISION_INSPECT', 'TOL_A'],
        capexUsd: 520000,
        leadTimeWeeks: 20,
        oeeDelta: 0.04,
        description: 'Camera ring, lighting tunnel and SPC feedback into the process controller.',
      },
      {
        id: 'RF-ARB-250-CAV8',
        name: '8-cavity hot-runner conversion',
        addsFeatures: ['CAV_8'],
        capexUsd: 380000,
        leadTimeWeeks: 17,
        oeeDelta: 0.02,
        description: 'Larger platen, eight-drop hot runner and a rebuilt clamp. Doubles shots per cycle.',
      },
    ],
  },
  {
    id: 'MC-ARB-600',
    name: 'Arburg 600 Allrounder',
    supplier: 'Arburg',
    generation: 4,
    baseFeatures: [
      'MOLD',
      'PAINT',
      'CURE',
      'PACK',
      'VISION_INSPECT',
      'TOL_A',
      'TOL_B',
      'TOL_C',
      'ROBOT_LOAD',
      'AUTO_EJECT',
      'CAV_4',
      'CAV_8',
      'RESIN_STD',
      'RESIN_GF',
      'RESIN_HT',
      'CLEANROOM',
    ],
    retrofits: [
      {
        id: 'RF-ARB-600-FOOD',
        name: 'Food-grade material package',
        addsFeatures: ['FOOD_GRADE'],
        capexUsd: 300000,
        leadTimeWeeks: 14,
        oeeDelta: -0.01,
        description: 'Food-contact wetted parts and a validated cleaning regime on an existing cleanroom cell.',
      },
      {
        id: 'RF-ARB-600-LABEL',
        name: 'Print-and-apply labelling module',
        addsFeatures: ['LABEL'],
        capexUsd: 165000,
        leadTimeWeeks: 8,
        oeeDelta: 0.01,
        description: 'Inline label print, apply and verify at the pack-out conveyor.',
      },
    ],
  },
  {
    id: 'MC-ENG-VC1',
    name: 'Engel Victory Compact',
    supplier: 'Engel',
    generation: 1,
    baseFeatures: ['MOLD', 'TOL_C', 'CAV_2', 'RESIN_STD'],
    retrofits: [
      {
        id: 'RF-ENG-VC1-INSERT',
        name: 'Insert handling package',
        addsFeatures: ['METAL_AL', 'METAL_STEEL', 'ROBOT_LOAD'],
        capexUsd: 480000,
        leadTimeWeeks: 20,
        oeeDelta: 0.02,
        description: 'Insert magazine, pick head and vision confirmation. The over-moulding conversion.',
      },
      {
        id: 'RF-ENG-VC1-TOL',
        name: 'Closed-loop process control',
        addsFeatures: ['TOL_B'],
        capexUsd: 210000,
        leadTimeWeeks: 14,
        oeeDelta: 0.04,
        description: 'Cavity-pressure sensors and adaptive switchover. Halves dimensional drift.',
      },
    ],
  },
  {
    id: 'MC-ENG-DUO',
    name: 'Engel Duo Large-Tonnage',
    supplier: 'Engel',
    generation: 2,
    baseFeatures: ['MOLD', 'TOL_B', 'TOL_C', 'CAV_4', 'CAV_8', 'RESIN_STD', 'AUTO_EJECT', 'METAL_AL'],
    retrofits: [
      {
        id: 'RF-ENG-DUO-WELD',
        name: 'Downstream ultrasonic weld station',
        addsFeatures: ['WELD', 'ASSEMBLE'],
        capexUsd: 395000,
        leadTimeWeeks: 15,
        oeeDelta: 0.0,
        description: 'Two ultrasonic stacks and a fixture nest at the end of the take-away conveyor.',
      },
      {
        id: 'RF-ENG-DUO-STEEL',
        name: 'Steel insert package',
        addsFeatures: ['METAL_STEEL'],
        capexUsd: 155000,
        leadTimeWeeks: 10,
        oeeDelta: -0.01,
        description: 'Heavier magazine, induction pre-heat and a reinforced pick head.',
      },
      {
        id: 'RF-ENG-DUO-ROBOT',
        name: 'Top-entry robot and small-tool adapter',
        addsFeatures: ['ROBOT_LOAD', 'CAV_2'],
        capexUsd: 330000,
        leadTimeWeeks: 14,
        oeeDelta: 0.01,
        description:
          'Rail-mounted robot plus an adapter plate that lets a large-tonnage press hold a 2-cavity tool. Cheap capacity, poor economics per shot.',
      },
    ],
  },
  {
    id: 'MC-ENG-EMOTION',
    name: 'Engel e-motion',
    supplier: 'Engel',
    generation: 3,
    baseFeatures: [
      'MOLD',
      'TOL_A',
      'TOL_B',
      'TOL_C',
      'CAV_4',
      'CAV_8',
      'RESIN_STD',
      'RESIN_GF',
      'ROBOT_LOAD',
      'AUTO_EJECT',
      'CLEANROOM',
      'METAL_AL',
    ],
    retrofits: [
      {
        id: 'RF-ENG-EMOTION-VISION',
        name: 'Vision inspection tunnel',
        addsFeatures: ['VISION_INSPECT'],
        capexUsd: 290000,
        leadTimeWeeks: 11,
        oeeDelta: 0.02,
        description: 'Inline camera tunnel with reject diverter. Removes the manual gate check.',
      },
      {
        id: 'RF-ENG-EMOTION-LEAK',
        name: 'Leak and function test rig',
        addsFeatures: ['LEAK_TEST', 'FUNCTION_TEST', 'ESD'],
        capexUsd: 455000,
        leadTimeWeeks: 17,
        oeeDelta: -0.02,
        description: 'Pressure-decay rig and sealing fixtures. Adds a real cycle-time penalty.',
      },
    ],
  },
  {
    id: 'MC-KM-CX',
    name: 'KraussMaffei CX Series',
    supplier: 'KraussMaffei',
    generation: 2,
    baseFeatures: ['MOLD', 'TOL_B', 'TOL_C', 'CAV_2', 'CAV_4', 'RESIN_STD', 'RESIN_GF'],
    retrofits: [
      {
        id: 'RF-KM-CX-PAINT',
        name: 'Inline paint, cure and high-temperature package',
        addsFeatures: ['PAINT', 'CURE', 'RESIN_HT'],
        capexUsd: 870000,
        leadTimeWeeks: 26,
        oeeDelta: -0.03,
        description:
          'Booth, cure tunnel, extraction and permitting. The single most expensive capability in the network, and the one that unlocks the most routings.',
      },
      {
        id: 'RF-KM-CX-ROBOT',
        name: 'Robot load/unload',
        addsFeatures: ['ROBOT_LOAD', 'AUTO_EJECT'],
        capexUsd: 375000,
        leadTimeWeeks: 14,
        oeeDelta: 0.04,
        description: 'Top-entry robot on rails, shared between two presses.',
      },
      {
        id: 'RF-KM-CX-CLEAN',
        name: 'Cleanroom enclosure',
        addsFeatures: ['CLEANROOM', 'ESD'],
        capexUsd: 640000,
        leadTimeWeeks: 21,
        oeeDelta: 0.0,
        description: 'ISO Class 8 soft-wall enclosure, HEPA plenum and gowning airlock.',
      },
    ],
  },
  {
    id: 'MC-KM-PX',
    name: 'KraussMaffei PX Series',
    supplier: 'KraussMaffei',
    generation: 3,
    baseFeatures: [
      'MOLD',
      'ASSEMBLE',
      'WELD',
      'TOL_A',
      'TOL_B',
      'TOL_C',
      'CAV_4',
      'CAV_8',
      'RESIN_STD',
      'RESIN_GF',
      'AUTO_EJECT',
      'ROBOT_LOAD',
      'METAL_AL',
      'METAL_STEEL',
      'ESD',
    ],
    retrofits: [
      {
        id: 'RF-KM-PX-FUNCTION',
        name: 'End-of-line function test',
        addsFeatures: ['FUNCTION_TEST'],
        capexUsd: 310000,
        leadTimeWeeks: 13,
        oeeDelta: -0.01,
        description: 'Test nest and harness on an already-ESD-controlled cell. Every part measured, every part slower.',
      },
      {
        id: 'RF-KM-PX-PACK',
        name: 'Automatic pack-out',
        addsFeatures: ['PACK', 'LABEL'],
        capexUsd: 225000,
        leadTimeWeeks: 10,
        oeeDelta: 0.03,
        description: 'Case erector, drop-packer and label verification.',
      },
      {
        id: 'RF-KM-PX-CNC',
        name: 'Downstream CNC trim cell',
        addsFeatures: ['MACHINE_CNC'],
        capexUsd: 405000,
        leadTimeWeeks: 16,
        oeeDelta: 0.01,
        description: '3-axis trim router on the take-away conveyor, sharing the cell fixture library.',
      },
    ],
  },
  {
    id: 'MC-KM-GX',
    name: 'KraussMaffei GX Precision',
    supplier: 'KraussMaffei',
    generation: 4,
    baseFeatures: [
      'MOLD',
      'PAINT',
      'CURE',
      'PACK',
      'LABEL',
      'VISION_INSPECT',
      'MACHINE_CNC',
      'LEAK_TEST',
      'FUNCTION_TEST',
      'ESD',
      'TOL_A',
      'TOL_B',
      'TOL_C',
      'ROBOT_LOAD',
      'AUTO_EJECT',
      'CAV_4',
      'CAV_8',
      'RESIN_STD',
      'RESIN_GF',
      'RESIN_HT',
    ],
    retrofits: [
      {
        id: 'RF-KM-GX-FOOD',
        name: 'Food-grade conversion',
        addsFeatures: ['FOOD_GRADE', 'CLEANROOM'],
        capexUsd: 720000,
        leadTimeWeeks: 24,
        oeeDelta: -0.02,
        description: 'Food-contact wetted parts, validated cleaning and an enclosed transfer.',
      },
      {
        id: 'RF-KM-GX-ASSY',
        name: 'Integration and weld cell',
        addsFeatures: ['ASSEMBLE', 'WELD'],
        capexUsd: 380000,
        leadTimeWeeks: 17,
        oeeDelta: 0.0,
        description: 'Ultrasonic stacks and an assembly nest bolted onto the pack-out end.',
      },
    ],
  },
  {
    id: 'MC-SUM-SE',
    name: 'Sumitomo SE-EV',
    supplier: 'Sumitomo',
    generation: 3,
    baseFeatures: [
      'MOLD',
      'TOL_A',
      'TOL_B',
      'TOL_C',
      'CAV_4',
      'CAV_8',
      'RESIN_STD',
      'ROBOT_LOAD',
      'AUTO_EJECT',
      'ESD',
      'VISION_INSPECT',
    ],
    retrofits: [
      {
        id: 'RF-SUM-SE-CLEAN',
        name: 'Cleanroom + food-grade package',
        addsFeatures: ['CLEANROOM', 'FOOD_GRADE'],
        capexUsd: 560000,
        leadTimeWeeks: 19,
        oeeDelta: -0.01,
        description: 'Soft-wall enclosure plus a validated food-contact material changeover.',
      },
      {
        id: 'RF-SUM-SE-CNC',
        name: 'Downstream CNC trim cell',
        addsFeatures: ['MACHINE_CNC'],
        capexUsd: 405000,
        leadTimeWeeks: 16,
        oeeDelta: 0.01,
        description: '3-axis trim router, dust extraction and a shared fixture library.',
      },
      {
        id: 'RF-SUM-SE-ASSY',
        name: 'Assembly and weld nest',
        addsFeatures: ['ASSEMBLE', 'WELD'],
        capexUsd: 350000,
        leadTimeWeeks: 15,
        oeeDelta: 0.0,
        description: 'Ultrasonic stack and a two-station nest fed by the existing robot.',
      },
    ],
  },
  {
    id: 'MC-SUM-DECK',
    name: 'Sumitomo Deckel Finishing',
    supplier: 'Sumitomo',
    generation: 2,
    baseFeatures: [
      'MACHINE_CNC',
      'ASSEMBLE',
      'WELD',
      'LEAK_TEST',
      'FUNCTION_TEST',
      'ESD',
      'TOL_B',
      'TOL_C',
      'METAL_AL',
      'METAL_STEEL',
    ],
    retrofits: [
      {
        id: 'RF-SUM-DECK-TOLA',
        name: 'Precision spindle and scale upgrade',
        addsFeatures: ['TOL_A'],
        capexUsd: 265000,
        leadTimeWeeks: 12,
        oeeDelta: 0.02,
        description: 'Glass scales, thermal compensation and a rebuilt spindle.',
      },
      {
        id: 'RF-SUM-DECK-VISION',
        name: 'Vision inspection station',
        addsFeatures: ['VISION_INSPECT'],
        capexUsd: 330000,
        leadTimeWeeks: 13,
        oeeDelta: 0.02,
        description: 'Camera tunnel and reject diverter between the trim router and the test bench.',
      },
      {
        id: 'RF-SUM-DECK-PACK',
        name: 'Pack and label conversion',
        addsFeatures: ['PACK', 'LABEL'],
        capexUsd: 150000,
        leadTimeWeeks: 8,
        oeeDelta: 0.02,
        description: 'Drop-packer and print-and-apply head at the end of the finishing line.',
      },
    ],
  },
  {
    id: 'MC-NIS-PACK',
    name: 'Nissei Pack & Finish Line',
    supplier: 'Nissei',
    generation: 1,
    baseFeatures: ['PACK', 'LABEL', 'TOL_C', 'CLEANROOM'],
    retrofits: [
      {
        id: 'RF-NIS-PACK-VISION',
        name: 'Label verification camera',
        addsFeatures: ['VISION_INSPECT', 'TOL_B'],
        capexUsd: 120000,
        leadTimeWeeks: 8,
        oeeDelta: 0.03,
        description: 'Reads every label back and diverts mismatches. Cheapest capability in the network.',
      },
      {
        id: 'RF-NIS-PACK-ASSY',
        name: 'Manual assembly bench conversion',
        addsFeatures: ['ASSEMBLE', 'FUNCTION_TEST', 'ESD'],
        capexUsd: 190000,
        leadTimeWeeks: 11,
        oeeDelta: -0.02,
        description: 'Six operator stations, torque tooling, ESD flooring and a test nest. Labour-heavy by design.',
      },
      {
        id: 'RF-NIS-PACK-FOOD',
        name: 'Food-grade pack conversion',
        addsFeatures: ['FOOD_GRADE'],
        capexUsd: 135000,
        leadTimeWeeks: 9,
        oeeDelta: 0.0,
        description: 'Food-contact liners, validated cleaning and segregated storage.',
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Standard operations
// ---------------------------------------------------------------------------

/**
 * Eighteen standard operations across six stages. `stage` orders a routing and
 * lays out the canvas process lanes; `requiredFeatures` is what the capability
 * engine matches a work center's granted features against.
 *
 * Rate bands live here too. They are not part of the domain contract — they are
 * how the generator keeps implied rates in a believable place — but they belong
 * next to the operation they describe rather than buried in the generator.
 */
export interface OperationSpec extends StandardOperation {
  /** Eaches per hour before OEE, [min, max]. */
  rateBand: [number, number]
  /** Setup hours, [min, max]. Complexity, not size. */
  setupBand: [number, number]
  /** Labour hours as a multiple of machine hours, [min, max] before automation. */
  labourBand: [number, number]
  /** Good-parts yield, [min, max]. */
  yieldBand: [number, number]
}

export const OPERATION_SPECS: OperationSpec[] = [
  {
    id: 'OP-MOLD-A',
    code: 'OP-MOLD-A',
    name: 'Mould — tolerance A, 4-cavity',
    stage: 1,
    requiredFeatures: ['MOLD', 'TOL_A', 'CAV_4'],
    rateBand: [280, 700],
    setupBand: [1.2, 4],
    labourBand: [0.6, 1.4],
    yieldBand: [0.965, 0.992],
  },
  {
    id: 'OP-MOLD-B',
    code: 'OP-MOLD-B',
    name: 'Mould — tolerance B, 4-cavity',
    stage: 1,
    requiredFeatures: ['MOLD', 'TOL_B', 'CAV_4'],
    rateBand: [320, 820],
    setupBand: [1, 3.5],
    labourBand: [0.7, 1.6],
    yieldBand: [0.97, 0.994],
  },
  {
    id: 'OP-MOLD-C',
    code: 'OP-MOLD-C',
    name: 'Mould — tolerance C, 2-cavity',
    stage: 1,
    requiredFeatures: ['MOLD', 'TOL_C', 'CAV_2'],
    rateBand: [200, 520],
    setupBand: [0.8, 3],
    labourBand: [1.0, 2.5],
    yieldBand: [0.968, 0.99],
  },
  {
    id: 'OP-MOLD-HV',
    code: 'OP-MOLD-HV',
    name: 'Mould — high volume, 8-cavity',
    stage: 1,
    requiredFeatures: ['MOLD', 'CAV_8', 'AUTO_EJECT'],
    rateBand: [500, 900],
    setupBand: [1.5, 4.5],
    labourBand: [0.6, 1.2],
    yieldBand: [0.972, 0.995],
  },
  {
    id: 'OP-MOLD-GF',
    code: 'OP-MOLD-GF',
    name: 'Mould — glass-filled grade',
    stage: 1,
    requiredFeatures: ['MOLD', 'RESIN_GF', 'TOL_B'],
    rateBand: [220, 600],
    setupBand: [1.2, 4],
    labourBand: [0.8, 1.8],
    yieldBand: [0.965, 0.988],
  },
  {
    id: 'OP-OVERMOLD',
    code: 'OP-OVERMOLD',
    name: 'Over-mould metal insert',
    stage: 2,
    requiredFeatures: ['MOLD', 'METAL_AL', 'ROBOT_LOAD'],
    rateBand: [200, 460],
    setupBand: [1.5, 4.5],
    labourBand: [0.7, 1.5],
    yieldBand: [0.965, 0.986],
  },
  {
    id: 'OP-TRIM-CNC',
    code: 'OP-TRIM-CNC',
    name: 'CNC trim and machine',
    stage: 2,
    requiredFeatures: ['MACHINE_CNC', 'TOL_B'],
    rateBand: [180, 500],
    setupBand: [0.6, 2.5],
    labourBand: [0.9, 2.2],
    yieldBand: [0.97, 0.993],
  },
  {
    id: 'OP-PAINT',
    code: 'OP-PAINT',
    name: 'Paint and cure',
    stage: 3,
    requiredFeatures: ['PAINT', 'CURE'],
    rateBand: [400, 1200],
    setupBand: [1.5, 6],
    labourBand: [0.8, 1.9],
    yieldBand: [0.965, 0.988],
  },
  {
    id: 'OP-PAINT-HT',
    code: 'OP-PAINT-HT',
    name: 'Paint — high-temperature substrate',
    stage: 3,
    requiredFeatures: ['PAINT', 'CURE', 'RESIN_HT'],
    rateBand: [420, 900],
    setupBand: [2, 6],
    labourBand: [0.9, 2.0],
    yieldBand: [0.965, 0.984],
  },
  {
    id: 'OP-WELD',
    code: 'OP-WELD',
    name: 'Ultrasonic weld',
    stage: 4,
    requiredFeatures: ['WELD', 'ASSEMBLE'],
    rateBand: [200, 480],
    setupBand: [0.5, 1.5],
    labourBand: [1.0, 2.4],
    yieldBand: [0.972, 0.995],
  },
  {
    id: 'OP-ASSEMBLE',
    code: 'OP-ASSEMBLE',
    name: 'Mechanical assembly',
    stage: 4,
    requiredFeatures: ['ASSEMBLE', 'TOL_B'],
    rateBand: [150, 420],
    setupBand: [0.5, 1.5],
    labourBand: [1.2, 2.5],
    yieldBand: [0.975, 0.996],
  },
  {
    id: 'OP-ASSEMBLE-ESD',
    code: 'OP-ASSEMBLE-ESD',
    name: 'Assembly — ESD controlled',
    stage: 4,
    requiredFeatures: ['ASSEMBLE', 'ESD'],
    rateBand: [160, 400],
    setupBand: [0.5, 1.5],
    labourBand: [1.3, 2.5],
    yieldBand: [0.974, 0.995],
  },
  {
    id: 'OP-INSPECT',
    code: 'OP-INSPECT',
    name: 'Vision inspection',
    stage: 5,
    requiredFeatures: ['VISION_INSPECT', 'TOL_B'],
    rateBand: [600, 2000],
    setupBand: [0.5, 1.2],
    labourBand: [0.6, 1.6],
    yieldBand: [0.98, 0.999],
  },
  {
    id: 'OP-INSPECT-A',
    code: 'OP-INSPECT-A',
    name: 'Vision inspection — class A',
    stage: 5,
    requiredFeatures: ['VISION_INSPECT', 'TOL_A'],
    rateBand: [600, 1600],
    setupBand: [0.5, 1.5],
    labourBand: [0.6, 1.5],
    yieldBand: [0.978, 0.998],
  },
  {
    id: 'OP-LEAK-TEST',
    code: 'OP-LEAK-TEST',
    name: 'Leak test',
    stage: 5,
    requiredFeatures: ['LEAK_TEST'],
    rateBand: [600, 1400],
    setupBand: [0.5, 1.2],
    labourBand: [0.8, 1.9],
    yieldBand: [0.97, 0.994],
  },
  {
    id: 'OP-FUNCTION-TEST',
    code: 'OP-FUNCTION-TEST',
    name: 'End-of-line function test',
    stage: 5,
    requiredFeatures: ['FUNCTION_TEST', 'ESD'],
    rateBand: [620, 1500],
    setupBand: [0.5, 1.2],
    labourBand: [0.8, 2.0],
    yieldBand: [0.972, 0.995],
  },
  {
    id: 'OP-PACK',
    code: 'OP-PACK',
    name: 'Pack and label',
    stage: 6,
    requiredFeatures: ['PACK', 'LABEL'],
    rateBand: [800, 3000],
    setupBand: [0.5, 1],
    labourBand: [1.0, 2.3],
    yieldBand: [0.99, 0.999],
  },
  {
    id: 'OP-PACK-CLEAN',
    code: 'OP-PACK-CLEAN',
    name: 'Pack — cleanroom',
    stage: 6,
    requiredFeatures: ['PACK', 'CLEANROOM'],
    rateBand: [800, 2200],
    setupBand: [0.5, 1.2],
    labourBand: [1.1, 2.4],
    yieldBand: [0.988, 0.999],
  },
]

/** The eighteen operation specs as the plain contract type. */
export const STANDARD_OPERATIONS: StandardOperation[] = OPERATION_SPECS.map((spec) => ({
  id: spec.id,
  code: spec.code,
  name: spec.name,
  requiredFeatures: spec.requiredFeatures,
  stage: spec.stage,
}))

// ---------------------------------------------------------------------------
// Product hierarchy
// ---------------------------------------------------------------------------

export interface FamilySpec {
  id: FamilyId
  code: string
  name: string
  /** Group count under this family; they sum to ~40. */
  groupCount: number
  /** Relative share of the SKU population. */
  weight: number
  /** Operation ids this family's routings draw from, in stage order. */
  opPool: OperationId[]
}

export const FAMILY_SPECS: FamilySpec[] = [
  {
    id: 'F-HSG',
    code: 'HSG',
    name: 'Housings',
    groupCount: 6,
    weight: 18,
    opPool: [
      'OP-MOLD-A',
      'OP-MOLD-B',
      'OP-TRIM-CNC',
      'OP-PAINT',
      'OP-ASSEMBLE',
      'OP-INSPECT',
      'OP-PACK',
    ],
  },
  {
    id: 'F-CLO',
    code: 'CLO',
    name: 'Closures',
    groupCount: 5,
    weight: 14,
    opPool: ['OP-MOLD-C', 'OP-MOLD-HV', 'OP-TRIM-CNC', 'OP-INSPECT', 'OP-PACK'],
  },
  {
    id: 'F-FIT',
    code: 'FIT',
    name: 'Fittings',
    groupCount: 5,
    weight: 13,
    opPool: ['OP-MOLD-GF', 'OP-MOLD-B', 'OP-TRIM-CNC', 'OP-WELD', 'OP-LEAK-TEST', 'OP-PACK'],
  },
  {
    id: 'F-ENC',
    code: 'ENC',
    name: 'Enclosures',
    groupCount: 5,
    weight: 13,
    opPool: [
      'OP-MOLD-A',
      'OP-OVERMOLD',
      'OP-PAINT',
      'OP-ASSEMBLE-ESD',
      'OP-INSPECT',
      'OP-FUNCTION-TEST',
      'OP-PACK',
    ],
  },
  {
    id: 'F-TRY',
    code: 'TRY',
    name: 'Trays',
    groupCount: 4,
    weight: 10,
    opPool: ['OP-MOLD-HV', 'OP-MOLD-C', 'OP-TRIM-CNC', 'OP-INSPECT', 'OP-PACK-CLEAN'],
  },
  {
    id: 'F-BZL',
    code: 'BZL',
    name: 'Bezels',
    groupCount: 5,
    weight: 12,
    opPool: ['OP-MOLD-A', 'OP-TRIM-CNC', 'OP-PAINT', 'OP-ASSEMBLE', 'OP-INSPECT-A', 'OP-PACK'],
  },
  {
    id: 'F-MAN',
    code: 'MAN',
    name: 'Manifolds',
    groupCount: 5,
    weight: 10,
    opPool: [
      'OP-MOLD-GF',
      'OP-OVERMOLD',
      'OP-PAINT-HT',
      'OP-WELD',
      'OP-LEAK-TEST',
      'OP-INSPECT',
      'OP-PACK',
    ],
  },
  {
    id: 'F-CON',
    code: 'CON',
    name: 'Connectors',
    groupCount: 5,
    weight: 10,
    opPool: [
      'OP-MOLD-A',
      'OP-TRIM-CNC',
      'OP-ASSEMBLE-ESD',
      'OP-INSPECT-A',
      'OP-FUNCTION-TEST',
      'OP-PACK',
    ],
  },
]

/** Group name fragments, cycled per family so groups read like real master data. */
export const GROUP_NAME_PARTS: string[] = [
  'Standard',
  'Heavy Duty',
  'Compact',
  'Sealed',
  'High Temp',
  'Lightweight',
]
