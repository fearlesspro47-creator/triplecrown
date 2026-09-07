import { Router, type IRouter } from "express";
import healthRouter from "./health";
import playersRouter from "./players";
import gamesRouter from "./games";
import predictionsRouter from "./predictions";
import weatherRouter from "./weather";
import oddsRouter from "./odds";
import dashboardRouter from "./dashboard";
import lineupsRouter from "./lineups";
import pitchersRouter from "./pitchers";
import newsRouter from "./news";
import parlaysRouter from "./parlays";
import mlIngestRouter from "./mlIngest";
import membershipRouter from "./membership";
import { requireActiveMembership } from "../lib/membership";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/players", playersRouter);
router.use("/parlays", parlaysRouter);
router.use("/games", gamesRouter);
router.use("/predictions", predictionsRouter);
router.use("/weather", weatherRouter);
router.use("/pitchers", pitchersRouter);
router.use("/odds", requireActiveMembership, oddsRouter);
router.use("/lineups", lineupsRouter);
router.use("/dashboard", dashboardRouter);
router.use("/news", newsRouter);
router.use("/ml", mlIngestRouter);
router.use("/membership", membershipRouter);

export default router;
