const express = require("express");
const router = express.Router();
const suscripcionController = require("../controllers/suscripcion.controller");
const { authenticateToken, authorizeRole, authorizeCliente } = require("../middleware/auth.middleware");
const { requireTwoFactor } = require("../middleware/twoFactor.middleware");


// Rutas públicas (para obtener planes)
router.get("/suscripciones/tipos", suscripcionController.getTiposSuscripcion);

// Rutas protegidas para clientes
router.get("/cliente/suscripcion/mi-suscripcion", authenticateToken, authorizeCliente, requireTwoFactor, suscripcionController.getMiSuscripcion);
router.get("/cliente/suscripcion/historial", authenticateToken, authorizeCliente, requireTwoFactor, suscripcionController.getHistorialSuscripciones);
router.post("/cliente/suscripcion/crear", authenticateToken, authorizeCliente, requireTwoFactor, suscripcionController.crearSuscripcion);
router.post("/cliente/suscripcion/cancelar", authenticateToken, authorizeCliente, suscripcionController.cancelarSuscripcion);
router.get("/cliente/dashboard", authenticateToken, authorizeCliente, requireTwoFactor, suscripcionController.getDashboardStats);

// Rutas protegidas para admin
router.get("/admin/suscripciones", authenticateToken, authorizeRole([1]), suscripcionController.getAllSuscripciones);
router.post("/admin/suscripciones/:suscripcionid/renovar", authenticateToken, authorizeRole([1]), suscripcionController.renovarSuscripcionAdmin);
router.get("/admin/clientes", authenticateToken, authorizeRole([1]), suscripcionController.getClientesList);
router.post("/admin/suscripciones/crear", authenticateToken, authorizeRole([1]), suscripcionController.crearSuscripcionAdmin);
router.post("/admin/suscripciones/:suscripcionid/notificar-vencimiento", authenticateToken, authorizeRole([1]), suscripcionController.enviarNotificacionVencimiento);
router.post("/admin/suscripciones/verificar-vencimientos", authenticateToken, authorizeRole([1]), suscripcionController.verificarYNotificarVencimientos);
router.post('/suscripcion/checkout', authenticateToken, authorizeCliente, suscripcionController.crearPreferenciaPago);

module.exports = router;