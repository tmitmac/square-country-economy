
const PURCHASES_SHARE = 205.2 / 261.1;
const CONSUMPTION_SHARE = 0.59;
const DAYS = 365;

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function growthFactor(annualPercent) {
    return Math.pow(
        1 + clamp(annualPercent, -90, 100) / 100,
        1 / DAYS
    );
}

function initialiseSectors(state) {
    const s = state.simulation;
    const e = state.economy;

    if (s.sectors) return;

    // Preserve existing GDP, fiscal and trade figures.
    const consumption = Math.round(
        e.gdp * CONSUMPTION_SHARE
    );

    const governmentPurchases = Math.round(
        e.governmentExpenditure * PURCHASES_SHARE
    );

    const exports = e.exports;
    const imports = e.imports;

    const investment = Math.round(
        e.gdp - consumption -
        governmentPurchases - exports + imports
    );

    if (investment <= 0) {
        throw new Error(
            "Cannot initialise investment: " +
            "check current GDP and fiscal figures."
        );
    }

    s.sectors = {
        consumption,
        investment,
        governmentPurchases,
        exports,
        imports
    };

    // Start from an economy-wide neutral demand position.
    s.outputGap = 0;

    // Retain recent daily real growth observations.
    s.growthWindow = [];
}

function validateSectors(sectors) {
    for (const [name, value] of Object.entries(sectors)) {
        if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0
        ) {
            throw new Error(
                "Invalid economic sector: " + name
            );
        }
    }
}

function updateSectors(state, settings) {
    initialiseSectors(state);

    const e = state.economy;
    const s = state.simulation;
    const sectors = s.sectors;

    const {
        priceFactor,
        populationFactor,
        demandImpulse = 0,
        tradeChanges = {},
        governmentChanges = {}
    } = settings;

    const previousGDP = e.gdp;
    const previousRealGDP = s.realGDP;

    // Government revenue and total spending evolve
    // with prices and population before fiscal shocks.
    e.governmentRevenue =
        e.governmentRevenue * priceFactor *
        populationFactor +
        (governmentChanges.governmentRevenue || 0);

    e.governmentExpenditure =
        e.governmentExpenditure * priceFactor *
        populationFactor +
        (governmentChanges.governmentExpenditure || 0);

    if (
        e.governmentRevenue < 0 ||
        e.governmentExpenditure < 0
    ) {
        throw new Error(
            "Government fiscal levels cannot be negative."
        );
    }

    // Labour market conditions affect consumption.
    const employmentPressure =
        clamp((4.6 - e.unemployment) * 0.16, -1.5, 1.5);

    // Higher interest rates reduce consumption growth.
    const consumptionInterestPressure =
        clamp((3.75 - e.interestRate) * 0.10, -1, 1);

    const consumptionGrowth =
        2.0 + employmentPressure +
        consumptionInterestPressure;

    sectors.consumption *=
        growthFactor(consumptionGrowth) * priceFactor;

    // Business investment is more sensitive
    // to rates and economic confidence.
    const investmentGrowth = clamp(
        2.8 +
        (3.75 - e.interestRate) * 0.7 +
        (e.gdpGrowth - 2.4) * 0.25 -
        (e.unemployment - 4.6) * 0.30,
        -12,
        15
    );

    sectors.investment *=
        growthFactor(investmentGrowth) * priceFactor;

    // Existing AI GDP-growth proposals become
    // a daily domestic investment-demand impulse.
    // They no longer overwrite the GDP growth figure.
    sectors.investment +=
        previousGDP * demandImpulse / (100 * DAYS);

    // Government purchases are a share of total
    // government spending, not all spending.
    sectors.governmentPurchases =
        e.governmentExpenditure * PURCHASES_SHARE;

    // External demand has its own underlying growth.
    const externalDemand = s.externalDemandGrowth ?? 2.3;

    sectors.exports *=
        growthFactor(externalDemand) * priceFactor;

    // Imports grow with baseline domestic demand.
    const importGrowth = clamp(
        2.2 +
        (consumptionGrowth - 2.0) * 0.35 +
        (investmentGrowth - 2.8) * 0.20,
        -12,
        15
    );

    sectors.imports *=
        growthFactor(importGrowth) * priceFactor;

    // Approved trade shocks alter trade levels.
    sectors.exports += tradeChanges.exports || 0;
    sectors.imports += tradeChanges.imports || 0;

    validateSectors(sectors);

    // GDP is now the result of sector activity.
    const nominalGDP =
        sectors.consumption +
        sectors.investment +
        sectors.governmentPurchases +
        sectors.exports -
        sectors.imports;

    if (nominalGDP <= 0) {
        throw new Error(
            "GDP became non-positive. Simulation rejected."
        );
    }

    e.gdp = Math.round(nominalGDP);

    // Real GDP is derived from the nominal output
    // and the simulated price index.
    s.realGDP = nominalGDP / (s.priceIndex / 100);

    const realFactor = s.realGDP / previousRealGDP;

    // Store a 30-day rolling annualised growth estimate.
    // This is NOT an official year-on-year GDP release.
    const dailyLogGrowth = Math.log(realFactor);

    s.growthWindow.push(dailyLogGrowth);

    if (s.growthWindow.length > 30) {
        s.growthWindow.shift();
    }

    const averageGrowth =
        s.growthWindow.reduce((a, b) => a + b, 0) /
        s.growthWindow.length;

    e.gdpGrowth =
        (Math.exp(averageGrowth * DAYS) - 1) * 100;

    // Model potential real output growing 2.4% annually.
    if (!s.potentialRealGDP) {
        s.potentialRealGDP = previousRealGDP;
    }

    s.potentialRealGDP *= growthFactor(2.4);

    s.outputGap = clamp(
        (s.realGDP / s.potentialRealGDP - 1) * 100,
        -20,
        20
    );

    // Government debt accumulates the fiscal deficit.
    e.governmentDebt = Math.max(
        0,
        e.governmentDebt +
        (e.governmentExpenditure -
         e.governmentRevenue) / DAYS
    );

    // Copy independent trade values to the public economy.
    e.exports = Math.round(sectors.exports);
    e.imports = Math.round(sectors.imports);

    e.governmentRevenue =
        Math.round(e.governmentRevenue);

    e.governmentExpenditure =
        Math.round(e.governmentExpenditure);

    e.governmentDebt =
        Math.round(e.governmentDebt);

    for (const key of Object.keys(sectors)) {
        sectors[key] = Math.round(sectors[key]);
    }

    // Reconcile rounding without using investment
    // as an arbitrary balancing residual.
    e.gdp =
        sectors.consumption +
        sectors.investment +
        sectors.governmentPurchases +
        sectors.exports -
        sectors.imports;

    s.realGDP = e.gdp / (s.priceIndex / 100);

    return {
        nominalGDP: e.gdp,
        realGDP: s.realGDP,
        outputGap: s.outputGap,
        previousGDP
    };
}

module.exports = {
    initialiseSectors,
    updateSectors
};
