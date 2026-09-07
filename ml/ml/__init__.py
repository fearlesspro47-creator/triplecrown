"""Triple Crown AI — home-run ML pipeline (isolated batch service).

Reads real MLB Statcast via pybaseball, builds a leakage-safe batter-game
training frame, trains a calibrated XGBoost HR model, and (at serving time)
scores today's lineups into Postgres. The Node/Express API only READS the
results — no Python in the request path.
"""
