const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const { User, OtpVerification } = require("../models");
const { auth } = require("../middleware/auth");
const { sendSignupOTP, sendLoginOTP } = require("../utils/notifications");

const router = express.Router();

// Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET || "super_secret_himsaru_dev_key", { expiresIn: "30d" });
};

// Helper to generate 4-digit numeric OTP
const generateOTP = () => {
  return Math.floor(1000 + Math.random() * 9000).toString(); // Ensures 4 digits
};

// Helper to validate and clean 10-digit Indian phone number
const cleanPhoneNumber = (phone) => {
  const digits = phone.replace(/\D/g, "");
  // If it starts with 91 and has 12 digits, strip the 91
  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.substring(2);
  }
  return digits;
};

// @route   POST /api/auth/signup-otp
// @desc    Request OTP for registering a new user
// @access  Public
router.post(
  "/signup-otp",
  [
    body("firstName").trim().notEmpty().withMessage("First name is required"),
    body("lastName").optional().trim(),
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("phone").trim().notEmpty().withMessage("Phone is required")
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array().map(e => e.msg).join(", ") });
      }

      const { firstName, lastName, email, phone } = req.body;

      // Validate 10 digit phone number
      const cleanedPhone = cleanPhoneNumber(phone);
      if (cleanedPhone.length !== 10) {
        return res.status(400).json({ success: false, message: "Phone number must be exactly 10 digits." });
      }

      // Check if user already exists
      const existingUserEmail = await User.findOne({ email });
      if (existingUserEmail) {
        return res.status(400).json({ success: false, message: "User already exists with this email." });
      }

      const existingUserPhone = await User.findOne({ phone: cleanedPhone });
      if (existingUserPhone) {
        return res.status(400).json({ success: false, message: "User already exists with this phone number." });
      }

      // Generate single 4-digit OTP (same for both email and phone)
      const otp = generateOTP();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins expiry

      // Save/update verification entry
      await OtpVerification.findOneAndDelete({ $or: [{ email }, { phone: cleanedPhone }] });
      await OtpVerification.create({
        email,
        phone: cleanedPhone,
        otp,
        expiresAt
      });

      // Send same OTP to both email and phone
      await sendSignupOTP(email, cleanedPhone, otp);

      res.json({
        success: true,
        message: "OTP sent successfully to your email and phone number. You can use either."
      });
    } catch (err) {
      console.error("Signup OTP error:", err);
      res.status(500).json({ success: false, message: "Server error sending signup OTP." });
    }
  }
);

// @route   POST /api/auth/register
// @desc    Verify OTP and register new user
// @access  Public
router.post(
  "/register",
  [
    body("firstName").trim().notEmpty().withMessage("First name is required"),
    body("lastName").optional().trim(),
    body("email").isEmail().normalizeEmail().withMessage("Valid email is required"),
    body("phone").trim().notEmpty().withMessage("Phone is required"),
    body("otp").trim().notEmpty().withMessage("OTP is required")
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array().map(e => e.msg).join(", ") });
      }

      const { firstName, lastName, email, phone, otp } = req.body;
      const cleanedPhone = cleanPhoneNumber(phone);

      // Verify OTP in verification table
      const otpRecord = await OtpVerification.findOne({ email, phone: cleanedPhone });
      if (!otpRecord || otpRecord.expiresAt < new Date()) {
        return res.status(400).json({ success: false, message: "OTP expired or invalid. Please request a new OTP." });
      }

      if (otpRecord.otp !== otp) {
        return res.status(400).json({ success: false, message: "Incorrect OTP. Please check and try again." });
      }

      // Check again to avoid race conditions
      const existingUser = await User.findOne({ $or: [{ email }, { phone: cleanedPhone }] });
      if (existingUser) {
        return res.status(400).json({ success: false, message: "User already registered." });
      }

      // Create new user
      const user = await User.create({
        firstName,
        lastName: lastName || "",
        email,
        phone: cleanedPhone
      });

      // Clear the OTP verification entry
      await OtpVerification.findByIdAndDelete(otpRecord._id);

      const token = generateToken(user._id);

      res.status(201).json({
        success: true,
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          role: user.role,
          addresses: user.addresses || []
        }
      });
    } catch (err) {
      console.error("Register verification error:", err);
      res.status(500).json({ success: false, message: "Server error during registration." });
    }
  }
);

// @route   POST /api/auth/login-otp
// @desc    Request login OTP
// @access  Public
router.post(
  "/login-otp",
  [
    body("phone").trim().notEmpty().withMessage("Phone is required")
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array().map(e => e.msg).join(", ") });
      }

      const { phone } = req.body;
      const cleanedPhone = cleanPhoneNumber(phone);

      if (cleanedPhone.length !== 10) {
        return res.status(400).json({ success: false, message: "Phone number must be exactly 10 digits." });
      }

      // Check if user exists
      const user = await User.findOne({ phone: cleanedPhone });
      if (!user) {
        return res.status(404).json({ success: false, message: "No account found with this phone number. Please sign up first." });
      }

      // Generate 4-digit login OTP
      const otp = generateOTP();
      user.otp = otp;
      user.otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 mins expiry
      await user.save();

      // Send OTP to both phone and email
      await sendLoginOTP(cleanedPhone, user.email, otp);

      res.json({
        success: true,
        message: "OTP sent successfully to your phone and email. You can use either."
      });
    } catch (err) {
      console.error("Login OTP request error:", err);
      res.status(500).json({ success: false, message: "Server error sending login OTP." });
    }
  }
);

// @route   POST /api/auth/login
// @desc    Verify login OTP and sign in
// @access  Public
router.post(
  "/login",
  [
    body("phone").trim().notEmpty().withMessage("Phone is required"),
    body("otp").trim().notEmpty().withMessage("OTP is required")
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: errors.array().map(e => e.msg).join(", ") });
      }

      const { phone, otp } = req.body;
      const cleanedPhone = cleanPhoneNumber(phone);

      const user = await User.findOne({ phone: cleanedPhone });
      if (!user) {
        return res.status(400).json({ success: false, message: "Invalid credentials." });
      }

      // Verify OTP
      if (!user.otp || user.otpExpires < new Date() || String(user.otp) !== String(otp)) {
        return res.status(400).json({ success: false, message: "Invalid or expired OTP." });
      }

      // Clear OTP details
      user.otp = undefined;
      user.otpExpires = undefined;
      await user.save();

      const token = generateToken(user._id);

      res.json({
        success: true,
        token,
        user: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          role: user.role,
          addresses: user.addresses || []
        }
      });
    } catch (err) {
      console.error("Login verification error:", err);
      res.status(500).json({ success: false, message: "Server error during login." });
    }
  }
);

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get("/me", auth, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user._id,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        email: req.user.email,
        phone: req.user.phone,
        role: req.user.role,
        addresses: req.user.addresses || []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// @route   PUT /api/auth/address
// @desc    Add address
// @access  Private
router.put("/address", auth, async (req, res) => {
  try {
    const { name, phone, line1, line2, city, state, pincode, email, isDefault } = req.body;
    const user = await User.findById(req.user._id);

    if (isDefault) {
      user.addresses.forEach((addr) => (addr.isDefault = false));
    }

    user.addresses.push({ name, phone, line1, line2, city, state, pincode, email, isDefault });
    await user.save();

    res.json({ success: true, addresses: user.addresses });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Public
router.post("/logout", (req, res) => {
  res.json({ success: true, message: "Logged out successfully." });
});

module.exports = router;
