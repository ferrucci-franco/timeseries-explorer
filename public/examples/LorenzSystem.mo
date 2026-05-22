model LorenzSystem
  parameter Real beta = 8 / 3;
  parameter Real rho = 28;
  parameter Real sigma = 10;

  Real x(start = 1);
  Real y(start = 1);
  Real z(start = 1);
equation
  der(x) = sigma * (y - x);
  der(y) = x * (rho - z) - y;
  der(z) = x * y - beta * z;

  annotation(experiment(StartTime = 0, StopTime = 40, Interval = 0.01));
end LorenzSystem;
