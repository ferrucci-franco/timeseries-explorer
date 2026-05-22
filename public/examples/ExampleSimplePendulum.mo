model ExampleSimplePendulum
  parameter Real L(unit="m") = 1;
  parameter Real b(unit="N.m.s/rad") = 0.1;
  parameter Real g(unit="m/s2") = 9.81;
  parameter Real m(unit="kg") = 1;
  parameter Real omega0_deg = 0;
  parameter Real theta0_deg = 45;

  Real omega(start = omega0_deg * Modelica.Constants.pi / 180);
  Real theta(start = theta0_deg * Modelica.Constants.pi / 180);
  Real Ekin;
  Real Epot;
  Real Etot;
  Real omega_deg_s;
  Real theta_deg;
  Real x;
  Real y;
equation
  der(theta) = omega;
  der(omega) = -(g / L) * sin(theta) - (b / (m * L * L)) * omega;

  Ekin = 0.5 * m * (L * omega) ^ 2;
  Epot = m * g * L * (1 - cos(theta));
  Etot = Ekin + Epot;
  omega_deg_s = omega * 180 / Modelica.Constants.pi;
  theta_deg = theta * 180 / Modelica.Constants.pi;
  x = L * sin(theta);
  y = -L * cos(theta);

  annotation(experiment(StartTime = 0, StopTime = 20, Interval = 0.02));
end ExampleSimplePendulum;
