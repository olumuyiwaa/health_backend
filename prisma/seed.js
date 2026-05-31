// prisma/seed.js
// ─────────────────────────────────────────────────────────
// Healthcare Staffing Platform — Full Test Data Seed
// Run: node prisma/seed.js  OR  npm run seed
// ─────────────────────────────────────────────────────────
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

// ─── Colour helpers for console output ────────
const c = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
  bold:   '\x1b[1m',
};
const log  = (msg)        => console.log(`${c.green}✔${c.reset}  ${msg}`);
const info = (msg)        => console.log(`${c.cyan}→${c.reset}  ${msg}`);
const head = (msg)        => console.log(`\n${c.bold}${c.yellow}▸ ${msg}${c.reset}`);
const fail = (msg, err)   => console.error(`${c.red}✖${c.reset}  ${msg}`, err);

// ─── Shared password hash (all test accounts use "Password1") ──
const HASH = bcrypt.hashSync('Password1', 12);

// ─────────────────────────────────────────────
// SEED FUNCTIONS (in dependency order)
// ─────────────────────────────────────────────

// 1. USERS ──────────────────────────────────────────────────
async function seedUsers() {
  head('Users & Profiles');

  const usersData = [
    // Super Admins
    {
      email: 'superadmin@healthstaff.dev',
      role:  'SUPER_ADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      verificationStatus: 'VERIFIED',
      profile: { firstName: 'Alex',    lastName: 'Carter',  department: 'Operations' },
    },
    {
      email: 'ops@healthstaff.dev',
      role:  'SUPER_ADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      verificationStatus: 'VERIFIED',
      profile: { firstName: 'Morgan',  lastName: 'Ellis',   department: 'Compliance' },
    },
    // Recruiter
    {
      email: 'recruiter@healthstaff.dev',
      role:  'RECRUITER',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      verificationStatus: 'VERIFIED',
      profile: { firstName: 'Jamie',   lastName: 'Brooks',  department: 'Recruiting' },
    },
    // Nurses — 5 with varied designations
    {
      email: 'rn.adams@healthstaff.dev',
      role:  'NURSE',
      phone: '+12125550101',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      verificationStatus: 'VERIFIED',
      nurse: {
        firstName: 'Sarah',    lastName: 'Adams',
        designation: 'RN',     yearsOfExperience: 8,
        availabilityRadius: 25, isAvailable: true,
        bio: 'Experienced RN specialising in wound care and IV therapy.',
        addressLine1: '142 Maple Street', city: 'Austin', state: 'TX', zipCode: '78701',
        latitude: 30.2672, longitude: -97.7431,
      },
    },
    {
      email: 'lvn.johnson@healthstaff.dev',
      role:  'NURSE',
      phone: '+12125550102',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      verificationStatus: 'VERIFIED',
      nurse: {
        firstName: 'Marcus',   lastName: 'Johnson',
        designation: 'LVN',    yearsOfExperience: 4,
        availabilityRadius: 15, isAvailable: true,
        bio: 'LVN with strong medication administration background.',
        addressLine1: '88 Oak Ave', city: 'Austin', state: 'TX', zipCode: '78702',
        latitude: 30.2611, longitude: -97.7262,
      },
    },
    {
      email: 'cna.roberts@healthstaff.dev',
      role:  'NURSE',
      phone: '+12125550103',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      verificationStatus: 'VERIFIED',
      nurse: {
        firstName: 'Diana',    lastName: 'Roberts',
        designation: 'CNA',    yearsOfExperience: 2,
        availabilityRadius: 10, isAvailable: true,
        bio: 'CNA focused on patient daily care and comfort.',
        addressLine1: '310 Cedar Blvd', city: 'Austin', state: 'TX', zipCode: '78703',
        latitude: 30.2745, longitude: -97.7596,
      },
    },
    {
      email: 'hha.wilson@healthstaff.dev',
      role:  'NURSE',
      phone: '+12125550104',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      verificationStatus: 'VERIFIED',
      nurse: {
        firstName: 'Leon',     lastName: 'Wilson',
        designation: 'HHA',    yearsOfExperience: 3,
        availabilityRadius: 20, isAvailable: false,
        bio: 'Certified HHA providing in-home personal care.',
        addressLine1: '55 Elm Court', city: 'Austin', state: 'TX', zipCode: '78704',
        latitude: 30.2519, longitude: -97.7527,
      },
    },
    {
      email: 'rn.chen@healthstaff.dev',
      role:  'NURSE',
      phone: '+12125550105',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      verificationStatus: 'VERIFIED',
      nurse: {
        firstName: 'Priya',    lastName: 'Chen',
        designation: 'RN',     yearsOfExperience: 12,
        availabilityRadius: 30, isAvailable: true,
        bio: 'Senior RN with OASIS certification and paediatric experience.',
        addressLine1: '200 Pine Road', city: 'Austin', state: 'TX', zipCode: '78705',
        latitude: 30.2849, longitude: -97.7341,
      },
    },
  ];

  const created = {};

  for (const u of usersData) {
    const { profile, nurse, ...userData } = u;

    const user = await prisma.user.create({
      data: {
        ...userData,
        passwordHash: HASH,
        lastLoginAt: new Date(),
      },
    });

    if (profile) {
      await prisma.adminProfile.create({
        data: { userId: user.id, ...profile },
      });
    }

    if (nurse) {
      const nurseProfile = await prisma.nurseProfile.create({
        data: { userId: user.id, ...nurse },
      });
      await prisma.wallet.create({ data: { nurseProfileId: nurseProfile.id } });
      created[user.email] = { user, nurseProfile };
      log(`Nurse: ${nurse.firstName} ${nurse.lastName} (${nurse.designation})`);
    } else {
      created[user.email] = { user };
      log(`User: ${profile?.firstName} ${profile?.lastName} (${user.role})`);
    }
  }

  return created;
}

// 2. FACILITIES ─────────────────────────────────────────────
async function seedFacilities(userMap) {
  head('Facilities');

  const facilitiesData = [
    {
      name:      'SunBridge Home Care',
      email:     'admin@sunbridge.dev',
      phone:     '+15125550201',
      taxId:     '12-3456789',
      npiNumber: '1234567890',
      status:    'ACTIVE',
      adminFirst: 'Kelly', adminLast: 'Nguyen',
      adminEmail: 'admin@sunbridge.dev',
      address: {
        label: 'Main Office', addressLine1: '500 Congress Ave',
        city: 'Austin', state: 'TX', zipCode: '78701',
        latitude: 30.2686, longitude: -97.7404, isPrimary: true,
      },
      billing: {
        billingName: 'SunBridge Home Care LLC', billingEmail: 'billing@sunbridge.dev',
        addressLine1: '500 Congress Ave', city: 'Austin', state: 'TX', zipCode: '78701',
      },
      staffPrefs: {
        preferredDesignations: ['RN', 'LVN', 'CNA'],
        genderPreference: 'any', maxRadiusMiles: 30, autoApproveBookings: false,
      },
    },
    {
      name:      'Emerald Gardens SNF',
      email:     'admin@emeraldgardens.dev',
      phone:     '+15125550202',
      taxId:     '98-7654321',
      npiNumber: '0987654321',
      status:    'ACTIVE',
      adminFirst: 'Brian', adminLast: 'Foster',
      adminEmail: 'admin@emeraldgardens.dev',
      address: {
        label: 'Nursing Facility', addressLine1: '1200 Lamar Blvd',
        city: 'Austin', state: 'TX', zipCode: '78703',
        latitude: 30.2749, longitude: -97.7602, isPrimary: true,
      },
      billing: {
        billingName: 'Emerald Gardens SNF Inc', billingEmail: 'accounts@emeraldgardens.dev',
        addressLine1: '1200 Lamar Blvd', city: 'Austin', state: 'TX', zipCode: '78703',
      },
      staffPrefs: {
        preferredDesignations: ['RN', 'CNA', 'HHA'],
        genderPreference: 'any', maxRadiusMiles: 20, autoApproveBookings: true,
      },
    },
    {
      name:      'ClearPath Health Agency',
      email:     'admin@clearpath.dev',
      phone:     '+15125550203',
      taxId:     '55-1122334',
      npiNumber: '5566778899',
      status:    'ACTIVE',
      adminFirst: 'Sandra', adminLast: 'Okonkwo',
      adminEmail: 'admin@clearpath.dev',
      address: {
        label: 'HQ', addressLine1: '340 West 6th Street',
        city: 'Austin', state: 'TX', zipCode: '78701',
        latitude: 30.2662, longitude: -97.7515, isPrimary: true,
      },
      billing: {
        billingName: 'ClearPath Health Agency Corp', billingEmail: 'billing@clearpath.dev',
        addressLine1: '340 West 6th Street', city: 'Austin', state: 'TX', zipCode: '78701',
      },
      staffPrefs: {
        preferredDesignations: ['LVN', 'CNA', 'HHA', 'CAREGIVER'],
        genderPreference: 'any', maxRadiusMiles: 25, autoApproveBookings: false,
      },
    },
  ];

  const facilities = [];

  for (const fd of facilitiesData) {
    const { address, billing, staffPrefs, adminFirst, adminLast, adminEmail, ...fData } = fd;
    const slug = fData.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const facility = await prisma.facility.create({ data: { ...fData, slug } });

    await prisma.facilityAddress.create({ data: { facilityId: facility.id, ...address } });
    await prisma.facilityBilling.create({ data: { facilityId: facility.id, ...billing } });
    await prisma.staffingPreference.create({ data: { facilityId: facility.id, ...staffPrefs } });
    await prisma.facilityNotificationPref.create({
      data: {
        facilityId: facility.id,
        emailOnNewBooking: true, emailOnCancellation: true,
        emailOnVisitComplete: true, smsOnEmergencyFill: true, pushEnabled: true,
      },
    });

    // Create facility admin user
    const adminUser = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: HASH,
        role: 'FACILITY_ADMIN',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        verificationStatus: 'VERIFIED',
      },
    });
    await prisma.adminProfile.create({
      data: { userId: adminUser.id, firstName: adminFirst, lastName: adminLast },
    });
    await prisma.facilityMember.create({
      data: {
        facilityId: facility.id, userId: adminUser.id,
        firstName: adminFirst, lastName: adminLast,
        jobTitle: 'Facility Administrator', isActive: true,
      },
    });

    // Workplace requirements
    const reqTypes = ['STATE_LICENSE', 'CPR_CERTIFICATION', 'TB_TEST', 'BACKGROUND_CHECK'];
    for (const credentialType of reqTypes) {
      await prisma.workplaceRequirement.create({
        data: {
          facilityId: facility.id,
          credentialType,
          isMandatory: true,
          appliesToRoles: ['RN', 'LVN', 'CNA'],
        },
      });
    }

    facilities.push({ facility, adminUser });
    log(`Facility: ${facility.name} (${slug})`);
  }

  return facilities;
}

// 3. CREDENTIALS ────────────────────────────────────────────
async function seedCredentials(userMap) {
  head('Credentials');

  const nurses = Object.values(userMap).filter((u) => u.nurseProfile);

  const credentialSets = [
    // For each nurse: 3 credentials with varied statuses
    [
      { type: 'STATE_LICENSE',       status: 'APPROVED', issuedAt: '2022-01-15', expiresAt: '2026-01-15' },
      { type: 'CPR_CERTIFICATION',   status: 'APPROVED', issuedAt: '2024-03-10', expiresAt: '2026-03-10' },
      { type: 'TB_TEST',             status: 'PENDING',  issuedAt: '2025-01-05', expiresAt: null         },
    ],
    [
      { type: 'STATE_LICENSE',       status: 'APPROVED', issuedAt: '2021-06-20', expiresAt: '2025-12-31' }, // expiring soon
      { type: 'BACKGROUND_CHECK',    status: 'APPROVED', issuedAt: '2023-09-01', expiresAt: '2025-09-01' },
      { type: 'GOVERNMENT_ID',       status: 'APPROVED', issuedAt: '2020-04-12', expiresAt: '2030-04-12' },
      { type: 'OIG_CHECK',           status: 'REJECTED', issuedAt: null,         expiresAt: null,
        rejectionReason: 'Document illegible — please re-upload a clear scan' },
    ],
    [
      { type: 'STATE_LICENSE',       status: 'APPROVED', issuedAt: '2023-02-28', expiresAt: '2027-02-28' },
      { type: 'CPR_CERTIFICATION',   status: 'APPROVED', issuedAt: '2024-05-15', expiresAt: '2026-05-15' },
      { type: 'SAM_CHECK',           status: 'PENDING',  issuedAt: null,         expiresAt: null         },
    ],
    [
      { type: 'STATE_LICENSE',       status: 'APPROVED', issuedAt: '2022-11-01', expiresAt: '2026-11-01' },
      { type: 'IMMUNIZATION',        status: 'APPROVED', issuedAt: '2023-10-20', expiresAt: null         },
      { type: 'WORK_AUTHORIZATION',  status: 'PENDING',  issuedAt: null,         expiresAt: null         },
    ],
    [
      { type: 'STATE_LICENSE',       status: 'APPROVED', issuedAt: '2019-07-14', expiresAt: '2027-07-14' },
      { type: 'CPR_CERTIFICATION',   status: 'APPROVED', issuedAt: '2024-08-01', expiresAt: '2026-08-01' },
      { type: 'BACKGROUND_CHECK',    status: 'APPROVED', issuedAt: '2024-01-10', expiresAt: '2026-01-10' },
      { type: 'TB_TEST',             status: 'APPROVED', issuedAt: '2024-06-05', expiresAt: null         },
    ],
  ];

  for (let i = 0; i < nurses.length; i++) {
    const { nurseProfile } = nurses[i];
    const set = credentialSets[i % credentialSets.length];

    for (const cred of set) {
      await prisma.credential.create({
        data: {
          nurseProfileId:  nurseProfile.id,
          type:            cred.type,
          fileUrl:         `https://your-bucket.nyc3.cdn.digitaloceanspaces.com/credentials/seed-${cred.type.toLowerCase()}-${i}.pdf`,
          fileKey:         `credentials/seed-${cred.type.toLowerCase()}-${i}.pdf`,
          status:          cred.status,
          issuedAt:        cred.issuedAt  ? new Date(cred.issuedAt)  : null,
          expiresAt:       cred.expiresAt ? new Date(cred.expiresAt) : null,
          rejectionReason: cred.rejectionReason || null,
          reviewedAt:      ['APPROVED', 'REJECTED'].includes(cred.status) ? new Date() : null,
        },
      });
    }
    log(`Credentials seeded for nurse: ${nurseProfile.firstName} ${nurseProfile.lastName}`);
  }
}

// 4. CASES ──────────────────────────────────────────────────
async function seedCases(facilities) {
  head('Cases');

  const casesData = [
    {
      facilityIdx: 0,
      publicIdentifier: 'Case-PT-1001',
      patientFirstName: 'Robert',   patientLastName: 'Harmon',
      dateOfBirth:  '1945-03-22',   gender: 'Male',
      primaryDiagnosis: 'CHF — Congestive Heart Failure',
      addressLine1: '720 Riverside Dr', city: 'Austin', state: 'TX', zipCode: '78701',
      latitude: 30.2680, longitude: -97.7460,
      isOasisCase: true,  oasisType: 'ADMISSION',
      visitType:   'ADMISSION',
      specialties: ['WOUND_CARE', 'IV_INFUSION'],
      notes: 'Patient lives alone. Emergency contact: daughter (512-555-0001).',
    },
    {
      facilityIdx: 0,
      publicIdentifier: 'Case-PT-1002',
      patientFirstName: 'Eleanor',  patientLastName: 'Voss',
      dateOfBirth:  '1952-08-11',   gender: 'Female',
      primaryDiagnosis: 'COPD — Stage III',
      addressLine1: '14 Birchwood Ln', city: 'Austin', state: 'TX', zipCode: '78702',
      latitude: 30.2605, longitude: -97.7280,
      isOasisCase: false, oasisType: null,
      visitType:   'REGULAR',
      specialties: ['COMPLEX_MEDICATION', 'DEMENTIA_CARE'],
      notes: 'Requires nebuliser treatment twice daily.',
    },
    {
      facilityIdx: 1,
      publicIdentifier: 'Case-PT-1003',
      patientFirstName: 'George',   patientLastName: 'Patel',
      dateOfBirth:  '1938-12-01',   gender: 'Male',
      primaryDiagnosis: 'Hip fracture — post-op recovery',
      addressLine1: '508 Meadow Way', city: 'Austin', state: 'TX', zipCode: '78703',
      latitude: 30.2750, longitude: -97.7590,
      isOasisCase: true,  oasisType: 'RECERTIFICATION',
      visitType:   'RECERTIFICATION',
      specialties: ['WOUND_CARE', 'PICC_LINE'],
      notes: 'Wound dressing change every 48 hours.',
    },
    {
      facilityIdx: 1,
      publicIdentifier: 'Case-PT-1004',
      patientFirstName: 'Mildred',  patientLastName: 'Osei',
      dateOfBirth:  '1960-05-30',   gender: 'Female',
      primaryDiagnosis: 'Type 2 Diabetes — insulin dependent',
      addressLine1: '900 Summit Pass', city: 'Austin', state: 'TX', zipCode: '78704',
      latitude: 30.2510, longitude: -97.7540,
      isOasisCase: false, oasisType: null,
      visitType:   'REGULAR',
      specialties: ['COMPLEX_MEDICATION', 'CATHETER_CARE'],
      notes: 'Blood glucose monitoring required at every visit.',
    },
    {
      facilityIdx: 2,
      publicIdentifier: 'Case-PT-1005',
      patientFirstName: 'Thomas',   patientLastName: 'Larkin',
      dateOfBirth:  '1950-09-17',   gender: 'Male',
      primaryDiagnosis: 'Stroke — left-side hemiplegia',
      addressLine1: '2233 Westover Hills', city: 'Austin', state: 'TX', zipCode: '78705',
      latitude: 30.2855, longitude: -97.7360,
      isOasisCase: true,  oasisType: 'RESUMPTION_OF_CARE',
      visitType:   'RESUMPTION_OF_CARE',
      specialties: ['TRACHEOSTOMY', 'VENTILATOR_SUPPORT'],
      notes: 'Patient uses a ventilator at night only.',
    },
  ];

  const cases = [];
  for (const cd of casesData) {
    const { facilityIdx, ...data } = cd;
    const c = await prisma.case.create({
      data: {
        ...data,
        facilityId:  facilities[facilityIdx].facility.id,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        isActive:    true,
      },
    });
    cases.push(c);
    log(`Case: ${c.publicIdentifier} — ${data.primaryDiagnosis.split('—')[0].trim()}`);
  }

  return cases;
}

// 5. SHIFTS ─────────────────────────────────────────────────
async function seedShifts(cases, facilities) {
  head('Shifts');

  const now    = new Date();
  const hour   = (h) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h);
  const days   = (d, h) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h);

  const shiftsData = [
    {
      caseIdx: 0, facilityIdx: 0,
      title: 'Admission Visit — RN Required',
      visitType: 'ADMISSION', requiredDesignation: 'RN',
      specialties: ['WOUND_CARE', 'IV_INFUSION'],
      pattern: 'ONE_TIME', period: 'DAY',
      scheduledStart: hour(9), scheduledEnd: hour(11),
      chargeRate: 85.00, payRate: 55.00,
      isUrgent: false, allowInstantBook: true,
      status: 'OPEN',
    },
    {
      caseIdx: 1, facilityIdx: 0,
      title: 'Regular Visit — Medication Administration',
      visitType: 'REGULAR', requiredDesignation: 'LVN',
      specialties: ['COMPLEX_MEDICATION'],
      pattern: 'RECURRING', period: 'DAY',
      scheduledStart: days(2, 10), scheduledEnd: days(2, 11),
      recurringDays: [1, 3, 5], // Mon, Wed, Fri
      recurringEndDate: days(30, 10),
      chargeRate: 70.00, payRate: 45.00,
      isUrgent: false, allowInstantBook: true,
      status: 'OPEN',
    },
    {
      caseIdx: 2, facilityIdx: 1,
      title: 'Recertification — RN OASIS Required',
      visitType: 'RECERTIFICATION', requiredDesignation: 'RN',
      specialties: ['WOUND_CARE', 'PICC_LINE'],
      pattern: 'ONE_TIME', period: 'DAY',
      scheduledStart: days(1, 8), scheduledEnd: days(1, 11),
      chargeRate: 110.00, payRate: 75.00,
      isUrgent: true, isEmergencyFill: false, allowInstantBook: true,
      status: 'OPEN',
    },
    {
      caseIdx: 3, facilityIdx: 1,
      title: 'Night Shift — CNA Daily Care',
      visitType: 'REGULAR', requiredDesignation: 'CNA',
      specialties: [],
      pattern: 'RECURRING', period: 'NIGHT',
      scheduledStart: days(1, 20), scheduledEnd: days(2, 6),
      recurringDays: [0, 1, 2, 3, 4, 5, 6], // daily
      recurringEndDate: days(14, 20),
      chargeRate: 55.00, payRate: 32.00,
      isUrgent: false, allowInstantBook: true,
      status: 'OPEN',
    },
    {
      caseIdx: 4, facilityIdx: 2,
      title: 'Emergency Fill — Ventilator Patient',
      visitType: 'RESUMPTION_OF_CARE', requiredDesignation: 'RN',
      specialties: ['TRACHEOSTOMY', 'VENTILATOR_SUPPORT'],
      pattern: 'ONE_TIME', period: 'DAY',
      scheduledStart: hour(7), scheduledEnd: hour(10),
      chargeRate: 130.00, payRate: 90.00,
      isUrgent: true, isEmergencyFill: true, allowInstantBook: false,
      status: 'OPEN',
    },
  ];

  const shifts = [];
  for (const sd of shiftsData) {
    const { caseIdx, facilityIdx, ...data } = sd;
    const s = await prisma.shift.create({
      data: {
        ...data,
        caseId:     cases[caseIdx].id,
        facilityId: facilities[facilityIdx].facility.id,
        specialties:   data.specialties || [],
        recurringDays: data.recurringDays || [],
        chargeRate: data.chargeRate,
        payRate:    data.payRate,
      },
    });
    shifts.push(s);
    log(`Shift: ${s.title} (${s.status})`);
  }

  return shifts;
}

// 6. ASSIGNMENTS & VISITS ───────────────────────────────────
async function seedAssignmentsAndVisits(shifts, userMap) {
  head('Shift Assignments & Visits');

  const nurses = Object.values(userMap).filter((u) => u.nurseProfile);
  // Assign the first two shifts to nurses
  const assignData = [
    { shiftIdx: 0, nurseIdx: 0, status: 'ACCEPTED' }, // RN Adams → Admission
    { shiftIdx: 1, nurseIdx: 1, status: 'ACCEPTED' }, // LVN Johnson → Regular
    { shiftIdx: 3, nurseIdx: 2, status: 'ACCEPTED' }, // CNA Roberts → Night
  ];

  const assignments = [];

  for (const ad of assignData) {
    const shift  = shifts[ad.shiftIdx];
    const nurse  = nurses[ad.nurseIdx].nurseProfile;

    // Mark shift as booked
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'BOOKED' } });

    const assignment = await prisma.shiftAssignment.create({
      data: {
        shiftId:        shift.id,
        nurseProfileId: nurse.id,
        status:         ad.status,
        acceptedAt:     new Date(),
      },
    });

    // Create associated visit record
    const visit = await prisma.visit.create({
      data: {
        assignmentId:   assignment.id,
        nurseProfileId: nurse.id,
        shiftId:        shift.id,
        status:         'SCHEDULED',
      },
    });

    assignments.push({ assignment, visit, nurse, shift });
    log(`Assignment: ${nurse.firstName} ${nurse.lastName} → ${shift.title}`);
  }

  // Simulate one completed visit (checked in + out)
  const completed = assignments[0];
  await prisma.visit.update({
    where: { id: completed.visit.id },
    data: {
      status:            'CHECKED_OUT',
      checkInTime:       new Date(Date.now() - 2 * 60 * 60 * 1000),
      checkInLatitude:   30.2680,
      checkInLongitude:  -97.7460,
      checkInDistance:   18,
      checkOutTime:      new Date(Date.now() - 30 * 60 * 1000),
      checkOutLatitude:  30.2681,
      checkOutLongitude: -97.7462,
      checkOutDistance:  22,
      durationMinutes:   90,
      notes:             'Visit completed. Wound dressing changed, IV line flushed.',
    },
  });
  await prisma.shift.update({ where: { id: completed.shift.id }, data: { status: 'COMPLETED' } });
  await prisma.shiftAssignment.update({ where: { id: completed.assignment.id }, data: { status: 'COMPLETED', completedAt: new Date() } });

  // Add visit audit log entries
  await prisma.visitAuditLog.createMany({
    data: [
      { visitId: completed.visit.id, action: 'CHECK_IN',  performedById: null, metadata: { latitude: 30.2680, longitude: -97.7460, distance: 18 } },
      { visitId: completed.visit.id, action: 'CHECK_OUT', performedById: null, metadata: { latitude: 30.2681, longitude: -97.7462, durationMinutes: 90 } },
    ],
  });

  // Simulate one flagged visit (out of geofence)
  const flagged = assignments[1];
  await prisma.visit.update({
    where: { id: flagged.visit.id },
    data: {
      status:           'FLAGGED',
      checkInTime:      new Date(Date.now() - 60 * 60 * 1000),
      checkInLatitude:  30.3100,   // ~5km away
      checkInLongitude: -97.8000,
      checkInDistance:  4800,
      overrideRequired: true,
      overrideReason:   'Check-in location is 4800m from case address (limit: 200m)',
    },
  });
  await prisma.visitAuditLog.create({
    data: {
      visitId:   flagged.visit.id,
      action:    'CHECK_IN_FLAGGED',
      metadata:  { latitude: 30.3100, longitude: -97.8000, distance: 4800 },
    },
  });
  log('Visit: flagged check-in (out of geofence) simulated');

  return assignments;
}

// 7. MESSAGING ──────────────────────────────────────────────
async function seedMessaging(userMap, facilities) {
  head('Conversations & Messages');

  const adminUser    = userMap['superadmin@healthstaff.dev'].user;
  const rnAdams      = userMap['rn.adams@healthstaff.dev'].user;
  const lvnJohnson   = userMap['lvn.johnson@healthstaff.dev'].user;
  const facilityAdmin = await prisma.user.findUnique({ where: { email: 'admin@sunbridge.dev' } });
  const facilityAdmin2 = await prisma.user.findUnique({ where: { email: 'admin@emeraldgardens.dev' } });

  const convData = [
    {
      participants: [adminUser.id, rnAdams.id],
      facilityId: null,
      messages: [
        { senderId: adminUser.id, content: 'Hi Sarah, your credentials have been reviewed. Your state license is now approved.' },
        { senderId: rnAdams.id,   content: 'Thank you! I will upload my TB test results shortly.' },
        { senderId: adminUser.id, content: 'Great — once that is in we can fully activate your profile.' },
      ],
    },
    {
      participants: [facilityAdmin.id, rnAdams.id],
      facilityId: facilities[0].facility.id,
      messages: [
        { senderId: facilityAdmin.id, content: 'Hello Sarah, we have an urgent admission visit tomorrow at 9AM. Are you available?' },
        { senderId: rnAdams.id,       content: 'Yes, I have already accepted it through the app. I will be there.' },
        { senderId: facilityAdmin.id, content: 'Perfect. The patient details are in the case notes. Please review before arrival.' },
        { senderId: rnAdams.id,       content: 'Understood. I see the wound care and IV requirements — I am prepared.' },
      ],
    },
    {
      participants: [facilityAdmin2.id, lvnJohnson.id],
      facilityId: facilities[1].facility.id,
      messages: [
        { senderId: facilityAdmin2.id, content: 'Marcus, the Monday recurring shift starts next week. Please confirm you are set.' },
        { senderId: lvnJohnson.id,     content: 'Confirmed. I have the patient address and medication list saved.' },
        { senderId: facilityAdmin2.id, content: 'Excellent. Contact me if anything changes.' },
      ],
    },
    {
      participants: [adminUser.id, facilityAdmin.id],
      facilityId: facilities[0].facility.id,
      messages: [
        { senderId: facilityAdmin.id, content: 'We need to discuss the check-in override for the flagged visit this morning.' },
        { senderId: adminUser.id,     content: 'I can see the flag. The nurse was 4.8km away — was this a legitimate visit?' },
        { senderId: facilityAdmin.id, content: 'She went to the wrong address initially. It is resolved now — please approve.' },
        { senderId: adminUser.id,     content: 'Override approved. I have updated the audit log accordingly.' },
      ],
    },
  ];

  for (const conv of convData) {
    const conversation = await prisma.conversation.create({
      data: {
        participantIds: conv.participants,
        facilityId:     conv.facilityId || null,
        lastMessageAt:  new Date(),
      },
    });

    let lastTime = new Date(Date.now() - conv.messages.length * 5 * 60 * 1000);
    for (const msg of conv.messages) {
      lastTime = new Date(lastTime.getTime() + 5 * 60 * 1000);
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId:       msg.senderId,
          content:        msg.content,
          status:         'READ',
          readAt:         new Date(),
          createdAt:      lastTime,
        },
      });
    }

    log(`Conversation: ${conv.messages.length} messages between ${conv.participants.length} participants`);
  }
}

// 8. NOTIFICATIONS ──────────────────────────────────────────
async function seedNotifications(userMap) {
  head('Notifications');

  const rnAdams    = userMap['rn.adams@healthstaff.dev'].user;
  const lvnJohnson = userMap['lvn.johnson@healthstaff.dev'].user;
  const cnaRoberts = userMap['cna.roberts@healthstaff.dev'].user;
  const adminUser  = userMap['superadmin@healthstaff.dev'].user;

  const notifData = [
    // RN Adams
    { userId: rnAdams.id,    type: 'BOOKING_CONFIRMATION', channel: 'PUSH',  title: 'Shift Booked',          body: 'Your admission visit on tomorrow at 9AM has been confirmed.',      isRead: false },
    { userId: rnAdams.id,    type: 'CREDENTIAL_APPROVED',  channel: 'EMAIL', title: 'Credential Approved',   body: 'Your State Nursing License has been approved.',                    isRead: true  },
    { userId: rnAdams.id,    type: 'NEW_MESSAGE',          channel: 'PUSH',  title: 'New Message',           body: 'SunBridge Home Care sent you a message.',                          isRead: false },
    // LVN Johnson
    { userId: lvnJohnson.id, type: 'ASSIGNMENT_UPDATE',    channel: 'PUSH',  title: 'New Shift Assignment',  body: 'You have been assigned to a recurring shift starting Monday.',     isRead: false },
    { userId: lvnJohnson.id, type: 'CREDENTIAL_EXPIRY',    channel: 'EMAIL', title: 'Credential Expiring',   body: 'Your State License expires in 14 days. Please upload a renewal.',  isRead: true  },
    { userId: lvnJohnson.id, type: 'SHIFT_ALERT',          channel: 'SMS',   title: 'Urgent Shift Available','body': 'An urgent RN shift near you was just posted.',                    isRead: false },
    // CNA Roberts
    { userId: cnaRoberts.id, type: 'BOOKING_CONFIRMATION', channel: 'PUSH',  title: 'Shift Booked',          body: 'Your night shift at Emerald Gardens starts tonight at 8PM.',       isRead: false },
    { userId: cnaRoberts.id, type: 'CREDENTIAL_REJECTED',  channel: 'EMAIL', title: 'Credential Rejected',   body: 'Your OIG Check was rejected. Reason: Document illegible.',          isRead: true  },
    // Admin
    { userId: adminUser.id,  type: 'SYSTEM_ALERT',         channel: 'EMAIL', title: 'Flagged Visit Override', body: 'A check-in override request requires your review.',                isRead: false },
    { userId: adminUser.id,  type: 'PAYMENT_ALERT',        channel: 'EMAIL', title: 'Payout Processed',      body: '3 nurse payouts totalling $580 were processed successfully.',       isRead: true  },
  ];

  await prisma.notification.createMany({ data: notifData.map((n) => ({ ...n, sentAt: new Date() })) });
  log(`${notifData.length} notifications created`);
}

// 9. BILLING ────────────────────────────────────────────────
async function seedBilling(facilities, userMap, shifts) {
  head('Wallets, Payouts & Invoices');

  const nurses = Object.values(userMap).filter((u) => u.nurseProfile);

  // Update wallet balances
  const walletBalances = [
    { pendingBalance: 275.00, availableBalance: 825.00, lifetimeEarnings: 1100.00 },
    { pendingBalance: 135.00, availableBalance: 360.00, lifetimeEarnings:  495.00 },
    { pendingBalance:  64.00, availableBalance: 192.00, lifetimeEarnings:  256.00 },
    { pendingBalance:   0.00, availableBalance:  96.00, lifetimeEarnings:   96.00 },
    { pendingBalance: 450.00, availableBalance: 900.00, lifetimeEarnings: 2700.00 },
  ];

  for (let i = 0; i < nurses.length; i++) {
    const wallet = await prisma.wallet.findUnique({
      where: { nurseProfileId: nurses[i].nurseProfile.id },
    });
    if (wallet) {
      await prisma.wallet.update({
        where: { id: wallet.id },
        data:  walletBalances[i],
      });

      // Seed 3 payouts per nurse
      const payoutAmounts = [
        { gross: 110.00, net: 55.00, commission: 55.00, status: 'SETTLED' },
        { gross:  85.00, net: 42.50, commission: 42.50, status: 'SETTLED' },
        { gross:  70.00, net: 35.00, commission: 35.00, status: 'PENDING' },
      ];

      for (const p of payoutAmounts) {
        await prisma.payout.create({
          data: {
            nurseProfileId:  nurses[i].nurseProfile.id,
            walletId:        wallet.id,
            shiftId:         shifts[0].id,
            grossCharge:     p.gross,
            netPayout:       p.net,
            systemCommission: p.commission,
            stripeTransferId: p.status === 'SETTLED' ? `tr_seed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null,
            status:          p.status,
            paidAt:          p.status === 'SETTLED' ? new Date() : null,
          },
        });
      }
      log(`Wallet + payouts: ${nurses[i].nurseProfile.firstName} ${nurses[i].nurseProfile.lastName}`);
    }
  }

  // Seed invoices for each facility
  for (let i = 0; i < facilities.length; i++) {
    const { facility } = facilities[i];

    const invoicesData = [
      {
        invoiceNumber: `INV-2025-${String(i * 10 + 1).padStart(4, '0')}`,
        status:        'PAID',
        periodStart:   new Date('2025-04-01'),
        periodEnd:     new Date('2025-04-30'),
        subtotal:      1840.00,
        tax:           147.20,
        total:         1987.20,
        paidAt:        new Date('2025-05-05'),
        dueAt:         new Date('2025-05-15'),
        lineItems: [
          { description: 'Admission Visit — RN (2h)', quantity: 2, unitRate: 85.00,  amount: 170.00 },
          { description: 'Regular Shift — LVN (1h)', quantity: 8, unitRate: 70.00,  amount: 560.00 },
          { description: 'Night Shift — CNA (10h)',  quantity: 14, unitRate: 55.00, amount: 770.00 },
        ],
      },
      {
        invoiceNumber: `INV-2025-${String(i * 10 + 2).padStart(4, '0')}`,
        status:        'ISSUED',
        periodStart:   new Date('2025-05-01'),
        periodEnd:     new Date('2025-05-31'),
        subtotal:      2210.00,
        tax:           176.80,
        total:         2386.80,
        paidAt:        null,
        dueAt:         new Date('2025-06-15'),
        lineItems: [
          { description: 'Recertification — RN (3h)', quantity: 1,  unitRate: 110.00, amount: 110.00 },
          { description: 'Regular Shift — LVN (1h)', quantity: 12, unitRate: 70.00,  amount: 840.00 },
          { description: 'Emergency Fill — RN (3h)', quantity: 3,  unitRate: 130.00, amount: 390.00 },
        ],
      },
      {
        invoiceNumber: `INV-2025-${String(i * 10 + 3).padStart(4, '0')}`,
        status:        'OVERDUE',
        periodStart:   new Date('2025-03-01'),
        periodEnd:     new Date('2025-03-31'),
        subtotal:      975.00,
        tax:           78.00,
        total:         1053.00,
        paidAt:        null,
        dueAt:         new Date('2025-04-15'),
        lineItems: [
          { description: 'HHA Daily Visit (2h)', quantity: 13, unitRate: 55.00, amount: 715.00 },
          { description: 'Supervisory Check — RN (1h)', quantity: 3, unitRate: 85.00, amount: 255.00 },
        ],
      },
    ];

    for (const inv of invoicesData) {
      const { lineItems, ...invData } = inv;
      const invoice = await prisma.invoice.create({
        data: { ...invData, facilityId: facility.id },
      });

      await prisma.invoiceLineItem.createMany({
        data: lineItems.map((li) => ({ ...li, invoiceId: invoice.id })),
      });

      log(`Invoice: ${invoice.invoiceNumber} (${invoice.status}) — $${invoice.total}`);
    }
  }
}

// 10. AUDIT LOGS ─────────────────────────────────────────────
async function seedAuditLogs(userMap) {
  head('Audit Logs');

  const adminUser  = userMap['superadmin@healthstaff.dev'].user;
  const rnAdams    = userMap['rn.adams@healthstaff.dev'].user;
  const lvnJohnson = userMap['lvn.johnson@healthstaff.dev'].user;

  const logsData = [
    { userId: rnAdams.id,    action: 'LOGIN',    resource: 'User',       resourceId: rnAdams.id,    ipAddress: '192.168.1.10' },
    { userId: rnAdams.id,    action: 'UPLOAD',   resource: 'Credential', resourceId: 'cred-001',    ipAddress: '192.168.1.10', newData: { type: 'STATE_LICENSE' } },
    { userId: adminUser.id,  action: 'APPROVE',  resource: 'Credential', resourceId: 'cred-001',    ipAddress: '10.0.0.5',    newData: { status: 'APPROVED' } },
    { userId: lvnJohnson.id, action: 'LOGIN',    resource: 'User',       resourceId: lvnJohnson.id, ipAddress: '192.168.1.22' },
    { userId: adminUser.id,  action: 'SUSPEND',  resource: 'User',       resourceId: 'usr-test-99', ipAddress: '10.0.0.5',    newData: { reason: 'Repeated no-shows' } },
    { userId: adminUser.id,  action: 'APPROVE',  resource: 'Visit',      resourceId: 'visit-001',   ipAddress: '10.0.0.5',    newData: { override: true } },
    { userId: rnAdams.id,    action: 'UPDATE',   resource: 'NurseProfile', resourceId: rnAdams.id,  ipAddress: '192.168.1.10', newData: { isAvailable: true } },
  ];

  await prisma.auditLog.createMany({ data: logsData });
  log(`${logsData.length} audit log entries created`);
}

// ─────────────────────────────────────────────
// MAIN RUNNER
// ─────────────────────────────────────────────

async function main() {
  console.log(`\n${c.bold}${c.cyan}╔══════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.cyan}║  Healthcare Staffing Platform — DB Seed     ║${c.reset}`);
  console.log(`${c.bold}${c.cyan}╚══════════════════════════════════════════════╝${c.reset}\n`);

  info('Clearing existing data…');
  // Delete in reverse-dependency order to respect FK constraints
  await prisma.visitAuditLog.deleteMany();
  await prisma.visit.deleteMany();
  await prisma.shiftAssignment.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.case.deleteMany();
  await prisma.invoiceLineItem.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.credential.deleteMany();
  await prisma.workplaceRequirement.deleteMany();
  await prisma.facilityNotificationPref.deleteMany();
  await prisma.staffingPreference.deleteMany();
  await prisma.facilityBilling.deleteMany();
  await prisma.facilityAddress.deleteMany();
  await prisma.facilityMember.deleteMany();
  await prisma.facility.deleteMany();
  await prisma.adminProfile.deleteMany();
  await prisma.nurseProfile.deleteMany();
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.passwordReset.deleteMany();
  await prisma.user.deleteMany();
  info('Tables cleared.\n');

  try {
    const userMap    = await seedUsers();
    const facilities = await seedFacilities(userMap);
    await seedCredentials(userMap);
    const cases      = await seedCases(facilities);
    const shifts     = await seedShifts(cases, facilities);
    await seedAssignmentsAndVisits(shifts, userMap);
    await seedMessaging(userMap, facilities);
    await seedNotifications(userMap);
    await seedBilling(facilities, userMap, shifts);
    await seedAuditLogs(userMap);

    console.log(`\n${c.bold}${c.green}╔══════════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.bold}${c.green}║  Seed complete! ✔                           ║${c.reset}`);
    console.log(`${c.bold}${c.green}╚══════════════════════════════════════════════╝${c.reset}`);
    console.log(`
${c.bold}Test Credentials (all passwords: ${c.yellow}Password1${c.reset}${c.bold})${c.reset}
  ${c.cyan}Super Admin${c.reset}       superadmin@healthstaff.dev
  ${c.cyan}Ops Admin${c.reset}         ops@healthstaff.dev
  ${c.cyan}Recruiter${c.reset}         recruiter@healthstaff.dev
  ${c.cyan}Facility Admin 1${c.reset}  admin@sunbridge.dev
  ${c.cyan}Facility Admin 2${c.reset}  admin@emeraldgardens.dev
  ${c.cyan}Facility Admin 3${c.reset}  admin@clearpath.dev
  ${c.cyan}Nurse (RN)${c.reset}        rn.adams@healthstaff.dev
  ${c.cyan}Nurse (LVN)${c.reset}       lvn.johnson@healthstaff.dev
  ${c.cyan}Nurse (CNA)${c.reset}       cna.roberts@healthstaff.dev
  ${c.cyan}Nurse (HHA)${c.reset}       hha.wilson@healthstaff.dev
  ${c.cyan}Nurse (RN Sr)${c.reset}     rn.chen@healthstaff.dev
`);
  } catch (err) {
    fail('Seed failed:', err);
    throw err;
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
