import { scholasticTypeNames, scholasticDashboardType } from "../../utils/scholasticTypes.js";
import { countScholasticVows } from '../../utils/scholasticVows.js';
import { PrismaClient } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { HttpException } from '../../exceptions/HttpException.js';
import { logger } from '../../utils/logger.js';
import { JWT_SECRET } from "../../config/index.js";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();

export const getProvincesByConcretionCode = async (req, res, next) => {
  try {
    const { concretionCode } = req.params;

    // Validate input
    if (!concretionCode) {
      const errorMessage = 'Concretion code is required';
      logger.error(errorMessage);
      throw new HttpException(StatusCodes.BAD_REQUEST, errorMessage);
    }

    // Query to fetch provinces by concretion code
    const provinces = await prisma.province_mst.findMany({
      where: { concretion_code: concretionCode },
      select: {
        province_code: true,
        province_name: true,
      },
    });

    // Check if no results found
    if (provinces.length === 0) {
      const errorMessage = `No provinces found for the given concretion code: ${concretionCode}`;
      logger.warn(errorMessage);
      throw new HttpException(StatusCodes.NOT_FOUND, errorMessage);
    }

    // Log success and send response
    logger.info(`Provinces fetched successfully for concretion code: ${concretionCode}`);
    res.status(StatusCodes.OK).json(provinces);
  } catch (error) {
    // Log the error
    logger.error(`Error fetching provinces: ${error.message}`);

    // Handle known exceptions
    if (error instanceof HttpException) {
      res.status(error.status).json({ error: error.message });
    } else {
      // Handle unexpected errors
      next(new HttpException(StatusCodes.INTERNAL_SERVER_ERROR, 'Internal server error'));
    }
  }
};


export const getConcretionByLogin = async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
  
      // Step 1: Validate Authorization Header
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        logger.error("Access token is missing or invalid");
        return res
          .status(StatusCodes.UNAUTHORIZED)
          .json({ error: "Access token is missing or invalid" });
      }
  
      // Step 2: Extract the Token
      const token = authHeader.split(" ")[1];
  
      // Step 3: Verify and Decode the Token
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET); // Ensure JWT_SECRET is correctly configured in environment
      } catch (error) {
        logger.error(`JWT verification failed: ${error.message}`);
        if (error.name === "TokenExpiredError") {
          return res
            .status(StatusCodes.UNAUTHORIZED)
            .json({ error: "Token has expired" });
        }
        if (error.name === "JsonWebTokenError") {
          return res
            .status(StatusCodes.UNAUTHORIZED)
            .json({ error: "Invalid token" });
        }
        return res
          .status(StatusCodes.INTERNAL_SERVER_ERROR)
          .json({ error: "Failed to verify token" });
      }
  
      // Step 4: Extract concretion_code from the Decoded Token
      const concretionCode = decoded.concretion_code;
  
      if (!concretionCode) {
        logger.error("Concretion code is missing in the token");
        return res
          .status(StatusCodes.BAD_REQUEST)
          .json({ error: "Concretion code is missing in the token" });
      }
  
      // Step 5: Fetch Concretion Details from Database
      const concretion = await prisma.concretion_defination_mst.findFirst({
        where: {
          concretion_code: concretionCode,
        },
        select: {
          concretion_code: true,
          concretion_name: true,
          contact_name: true,
          mobile_isd: true,
          mobile_no: true,
          email: true,
          status: true,
        },
      });
  
      // Step 6: Handle Missing Concretion
      if (!concretion) {
        logger.warn(`No concretion found for code: ${concretionCode}`);
        return res
          .status(StatusCodes.NOT_FOUND)
          .json({ error: "Concretion not found" });
      }
  
      // Step 7: Return Concretion Details
      logger.info(`Concretion details fetched successfully for code: ${concretionCode}`);
      res.status(StatusCodes.OK).json(concretion);
    } catch (error) {
      // Step 8: Handle Unexpected Errors
      logger.error(`Error fetching concretion: ${error.message}`);
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: "Internal server error" });
    } finally {
      // Step 9: Ensure Database Connection is Closed
      await prisma.$disconnect();
    }
  };
  





export const getProvincesForConcretion = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let concretionCode;

    // Validate the JWT and extract concretion_code
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      concretionCode = decoded.concretion_code; // Extract concretion_code from token
    }

    if (!concretionCode) {
      return res.status(403).json({ error: "Unauthorized: Concretion code is missing." });
    }

    // Fetch all provinces for the concretion_code
    const provinces = await prisma.province_mst.findMany({
      where: {
        concretion_code: concretionCode,
      },
      select: {
        province_code: true,
        province_name: true,
        short_name: true,
        email: true,
        created_date: true,
      },
    });

    // Return the provinces
    res.json(provinces);
  } catch (error) {
    console.error("Error fetching provinces for concretion:", error);
    res.status(500).json({ message: "Failed to fetch provinces." });
  }
};



// Get counts by concretion for Super Admin and Concretion Admin
export const getConcretionCounts = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let concretion_code;
    let role_name;

    // Step 1: Validate the JWT token and extract the role and concretion
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      role_name = decoded.role_name?.toLowerCase(); // Extract user role
      concretion_code = decoded.concretion_code; // Extract concretion code from the token
    }

    // Step 2: Role-based filtering
    if (!role_name) {
      console.error("Role name not found in token.");
      return res.status(403).json({ error: "Role name not found in token." });
    }

    // Fetch quickcode_name from quickcode_mst for role validation
    const quickCodeRole = await prisma.quickcode_mst.findFirst({
      where: {
        quickcode_name: {
          equals: role_name, // Match case-insensitively
          mode: "insensitive",
        },
      },
    });
    

    if (!quickCodeRole) {
      console.error(`Invalid role: ${role_name}`);
      return res.status(403).json({ error: `Invalid role: ${role_name}` });
    }

    let concretionCounts = [];

    // Super Admin: Fetch data for all concretions
    if (role_name === "super admin") {
      concretionCounts = await prisma.concretion_defination_mst.findMany({
        select: {
          concretion_code: true,
          concretion_name: true,
          _count: {
            select: {
              province_mst: true, // Count provinces under each concretion
            },
          },
        },
      });
    } 
    // Concretion Admin: Fetch data for their assigned concretion
    else if (role_name === "concretion admin") {
      if (!concretion_code) {
        console.error("Concretion code is required for concretion admin role.");
        return res.status(400).json({ error: "Concretion code is required for this role." });
      }

      concretionCounts = await prisma.province_mst.findMany({
        where: { concretion_code },
        select: {
          province_code: true,
          province_name: true,
          _count: {
            select: {
              province_mst: true,
            },
          },
        },
      });
    } 
    // Congregation Admin: Example for handling other roles
    else if (role_name === "congregation admin") {
      concretionCounts = await prisma.quickcode_mst.findMany({
        where: {
          quickcode_name: "Congregation Admin", // Example condition
        },
        select: {
          quick_code: true,
          quickcode_name: true,
        },
      });
    }

    // Step 3: Check if data is found
    if (concretionCounts.length === 0) {
      console.warn(`No data found for role: ${role_name}, concretion_code: ${concretion_code}`);
      return res.status(404).json({
        message: `No data found for role: ${role_name}, concretion_code: ${concretion_code}`,
      });
    }

    // Step 4: Return the result
    res.json(concretionCounts);
  } catch (error) {
    // Log detailed error
    console.error("Error fetching concretion counts:", error);
    res.status(500).json({ message: "Failed to fetch concretion counts.", error: error.message });
  }
};



// Get province counts for a specific concretion
export const getProvinceCountsByConcretion = async (req, res) => {
  try {
    const { concretion_code } = req.body;

    if (!concretion_code) {
      return res.status(400).json({ error: "Concretion code is required." });
    }

    // Fetch provinces under the given concretion
    const provinces = await prisma.province_mst.findMany({
      where: { concretion_code },
      select: {
        province_code: true,
        province_name: true,
      },
    });

    // Return the province counts
    res.json({
      concretion_code,
      provinces,
      count: provinces.length,
    });
  } catch (error) {
    console.error("Error fetching province counts:", error);
    res.status(500).json({ message: "Failed to fetch province counts." });
  }
};

// Get all concretions (Super Admin only)
export const getAllConcretions = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let role_name;

    // Validate the JWT token
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      role_name = decoded.role_name.toLowerCase(); // Extract user role
    }

    if (role_name !== "super admin") {
      return res.status(403).json({ error: "Only Super Admin can access this data." });
    }

    // Fetch all concretions
    const concretions = await prisma.concretion_defination_mst.findMany({
      select: {
        concretion_code: true,
        concretion_name: true,
        contact_name: true,
        mobile_no: true,
        email: true,
        status: true,
      },
    });

    res.json(concretions);
  } catch (error) {
    console.error("Error fetching concretions:", error);
    res.status(500).json({ message: "Failed to fetch concretions." });
  }
};


export const getDivisionCountsByConcretion = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let role_name;
    let concretion_code;

    // Step 1: Validate the JWT token and extract role and concretion code
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      role_name = decoded.role_name.toLowerCase(); // Extract role
      concretion_code = decoded.concretion_code; // Extract concretion code
    }

    if (!role_name) {
      return res.status(403).json({ error: "Role name not found in token." });
    }

    // Step 2: Fetch division type mapping from quickcode_mst
    const quickcodeMapping = await prisma.quickcode_mst.findMany({
      where: { quick_code_type: "divtyp" },
      select: {
        quick_code: true, // e.g., div005
        quickcode_name: true, // e.g., Mission
      },
    });

    // Map quick_code to quickcode_name for lookup
    const divisionTypeMapping = Object.fromEntries(
      quickcodeMapping.map((qc) => [qc.quick_code, qc.quickcode_name])
    );

    // Filter valid division codes for predefined types
    const validDivisionTypes = ["Province", "Region", "Mission", "Delegation"];
    const validDivisionCodes = quickcodeMapping
      .filter((qc) => validDivisionTypes.includes(qc.quickcode_name))
      .map((qc) => qc.quick_code);

    // Step 3: Fetch provinces under the concretion
    const provinces = await prisma.province_mst.findMany({
      where: { concretion_code }, // Filter by concretion code
      select: {
        province_code: true,
        province_name: true,
      },
    });

    if (provinces.length === 0) {
      return res.status(404).json({ error: "No provinces found for this concretion." });
    }

    // Step 4: Fetch division counts for each province
    const divisionCounts = await prisma.division_setup_mst.groupBy({
      by: ["province_code", "division_type_code"],
      where: {
        province_code: { in: provinces.map((province) => province.province_code) },
        division_type_code: { in: validDivisionCodes }, // Use valid division codes from the mapping
      },
      _count: { division_type_code: true },
    });

    // Step 5: Aggregate division counts by province and division type
    const provinceDivisionCounts = provinces.map((province) => {
      const divisionCountsForProvince = validDivisionTypes.reduce((acc, type) => {
        const divisionCodesForType = quickcodeMapping
          .filter((qc) => qc.quickcode_name === type)
          .map((qc) => qc.quick_code);

        const countForType = divisionCounts
          .filter(
            (count) =>
              count.province_code === province.province_code &&
              divisionCodesForType.includes(count.division_type_code)
          )
          .reduce((sum, count) => sum + count._count.division_type_code, 0);

        acc[type] = countForType;
        return acc;
      }, {});

      return {
        province_code: province.province_code,
        province_name: province.province_name,
        division_counts: divisionCountsForProvince,
      };
    });

    // Step 6: Calculate total division counts for the entire concretion
    const totalDivisionCounts = validDivisionTypes.reduce((acc, type) => {
      const divisionCodesForType = quickcodeMapping
        .filter((qc) => qc.quickcode_name === type)
        .map((qc) => qc.quick_code);

      acc[type] = divisionCounts
        .filter((count) => divisionCodesForType.includes(count.division_type_code))
        .reduce((sum, count) => sum + count._count.division_type_code, 0);

      return acc;
    }, {});

    // Step 7: Return the response
    res.json({
      role_name,
      concretion_code,
      totalDivisionCounts,
      provinces: provinceDivisionCounts,
    });
  } catch (error) {
    console.error("Error fetching division counts:", error);
    res.status(500).json({ message: "Failed to fetch division counts." });
  }
};


export const getDivisionCountsforTokenConcretion = async (req, res) => {
  try {
      const authHeader = req.headers.authorization;
      let concretion_code;
      let role_name;

      if (authHeader && authHeader.startsWith("Bearer ")) {
          const token = authHeader.split(" ")[1];
          const decoded = jwt.verify(token, JWT_SECRET);

          role_name = decoded.role_name.toLowerCase();
          concretion_code = decoded.concretion_code;
      }

      if (!role_name) {
          return res.status(403).json({ error: "Role name not found in token." });
      }
      if (role_name !== "congregation admin") {
          return res.status(403).json({ error: "Access denied for this role." });
      }
      if (!concretion_code) {
          return res.status(400).json({ error: "Concretion code is required." });
      }

      console.log("🟢 Concretion Code:", concretion_code);

      const concretion = await prisma.concretion_defination_mst.findFirst({
          where: { concretion_code },
          select: { concretion_name: true },
      });

      if (!concretion_code) {
        console.error("❌ Missing concretion_code for congregation admin!");
        return res.status(400).json({ error: "Concretion code is required." });
    }
    


      const queryProvinceCode = req.query.province_code;


      let provinces;
      if (queryProvinceCode) {
          // Fetch only the specified province if queryProvinceCode is provided
          provinces = await prisma.province_mst.findMany({
              where: { concretion_code, province_code: queryProvinceCode },
              select: { province_code: true, province_name: true },
          });
          console.log("🟢 Provinces Retrieved:", provinces);
  
          if (!provinces || provinces.length === 0) {
              return res.status(404).json({ error: "No provinces found for this concretion." });
          }
      } else {
          // Fetch all provinces for the concretion if no province_code is provided in the query
          provinces = await prisma.province_mst.findMany({
              where: { concretion_code },
              select: { province_code: true, province_name: true },
          });
      }

      if (provinces.length === 0) {
          return res.status(404).json({ error: "No provinces found for this concretion." });
      }

      const provinceCodes = provinces.map((p) => p.province_code);

      const validQuickcodeNames = ["Province", "Region", "Mission", "Delegation"];
      const validQuickcodes = await prisma.quickcode_mst.findMany({
          where: {
              quick_code_type: "divtyp",
              quickcode_name: { in: validQuickcodeNames, mode: "insensitive" },
          },
          select: { quick_code: true, quickcode_name: true },
      });

      const quickcodeMap = Object.fromEntries(
          validQuickcodes.map((q) => [q.quick_code.toLowerCase(), q.quickcode_name.toLowerCase()])
      );

      const divisionCounts = await prisma.division_setup_mst.groupBy({
          by: ["division_type_code"],
          where: {
              province_code: { in: provinceCodes },
              division_type_code: { in: validQuickcodes.map((q) => q.quick_code) },
          },
          _count: { division_type_code: true },
      });

      const vowsCounts = await countScholasticVows(prisma, {
          province_code: { in: provinceCodes },
      });

      const memberTypeQuickcodes = await prisma.quickcode_mst.findMany({
          where: {
              quick_code_type: "memtyp",
              quickcode_name: { in: ["priest", "religious brother"], mode: "insensitive" },
          },
          select: { quick_code: true, quickcode_name: true },
      });

      const memberTypeMap = Object.fromEntries(
          memberTypeQuickcodes.map((q) => [q.quick_code.toLowerCase(), q.quickcode_name.toLowerCase()])
      );

      const memberCounts = await prisma.confreres_dtl.groupBy({
          by: ["member_type_code"],
          where: {
              province_code: { in: provinceCodes },
              member_type_code: { in: Object.keys(memberTypeMap) },
              is_active: true,
          },
          _count: { member_type_code: true },
      });

      const scholasticTypeQuickcodes = await prisma.quickcode_mst.findMany({
          where: {
              quick_code_type: "schtyp",
              quickcode_name: { in: [...scholasticTypeNames.NOVICE, ...scholasticTypeNames.MINOR_SEMINARIAN], mode: "insensitive" },
          },
          select: { quick_code: true, quickcode_name: true },
      });

      const scholasticTypeMap = Object.fromEntries(
          scholasticTypeQuickcodes.map((q) => [q.quick_code.toLowerCase(), scholasticDashboardType(q.quickcode_name)])
      );

      const scholasticCounts = await prisma.scholastics_admisn_promon_dtl.groupBy({
          by: ["scholastic_type_code"],
          where: {
              province_code: { in: provinceCodes },
              scholastic_type_code: { in: Object.keys(scholasticTypeMap), mode: "insensitive" },
              end_date: null,
          },
          _count: { scholastic_type_code: true },
      });

      const apostolateQuickcodes = await prisma.quickcode_mst.findMany({
          where: {
              quick_code_type: "apostl",
              quickcode_name: { in: ["Mission", "Formation", "Education", "SAIM"], mode: "insensitive" },
          },
          select: { quick_code: true, quickcode_name: true },
      });

      const apostolateTypeMap = Object.fromEntries(
          apostolateQuickcodes.map((q) => [q.quick_code.toLowerCase(), q.quickcode_name.toLowerCase()])
      );

      const apostolateCounts = {};

      const apostolates = await prisma.apostolates_mst.findMany({
          where: {
              province_code: { in: provinceCodes },
              apostolate_code: { in: Object.keys(apostolateTypeMap) },
          },
          select: {
              apostolate_code: true,
              centre_type_code: true,
              centre_type_name: true,
          },
      });

      const [centreTypeCounts, dioceseCounts] = await Promise.all([
          prisma.centre_dtl.groupBy({
              by: ["apostolate_code", "centre_type_code"],
              where: { province_code: { in: provinceCodes } },
              _count: { centre_code: true },
          }),
          prisma.centre_dtl.groupBy({
              by: ["apostolate_code"],
              where: {
                  province_code: { in: provinceCodes },
                  diocese_code: { not: "" },
              },
              _count: { centre_code: true },
          }),
      ]);

      const processedCentreCombinations = new Set();
      const processedDioceseApostolates = new Set();

      for (const apostolate of apostolates) {
          const apostolateType = apostolateTypeMap[apostolate.apostolate_code.toLowerCase()];
          if (!apostolateType) continue;

          if (!apostolateCounts[apostolateType]) {
              apostolateCounts[apostolateType] = {};
          }

          const centreCombinationKey = `${apostolate.apostolate_code}:${apostolate.centre_type_code}`;
          if (!processedCentreCombinations.has(centreCombinationKey)) {
              processedCentreCombinations.add(centreCombinationKey);
              const centreCount = centreTypeCounts.find((count) =>
                  count.apostolate_code === apostolate.apostolate_code &&
                  count.centre_type_code === apostolate.centre_type_code
              )?._count.centre_code || 0;

              if (centreCount >= 1) {
                  apostolateCounts[apostolateType][apostolate.centre_type_name] =
                      (apostolateCounts[apostolateType][apostolate.centre_type_name] || 0) + centreCount;
              }
          }

          if (!processedDioceseApostolates.has(apostolate.apostolate_code)) {
              processedDioceseApostolates.add(apostolate.apostolate_code);
              const diocseCount = dioceseCounts.find((count) =>
                  count.apostolate_code === apostolate.apostolate_code
              )?._count.centre_code || 0;

              apostolateCounts[apostolateType].diocse =
                  (apostolateCounts[apostolateType].diocse || 0) + diocseCount;
          }
      }

      const aggregatedCounts = validQuickcodeNames.reduce((acc, name) => {
          const quickCodesForName = validQuickcodes
              .filter((q) => q.quickcode_name.toLowerCase() === name.toLowerCase())
              .map((q) => q.quick_code);

          const totalCount = divisionCounts
              .filter((dc) => quickCodesForName.includes(dc.division_type_code))
              .reduce((sum, dc) => sum + dc._count.division_type_code, 0);

          acc[name] = totalCount;
          return acc;
      }, {});

      const sumGroupedCount = (groups, codeField, countField, typeMap, expectedName) =>
          groups
              .filter((group) => typeMap[group[codeField]?.toLowerCase()] === expectedName)
              .reduce((total, group) => total + group._count[countField], 0);

      res.json({
          concretion_code,
          concretion_name: concretion.concretion_name,
          role_name,
          provinces: provinces.map((p) => ({ province_code: p.province_code, province_name: p.province_name })),
          firstProfessionCount: vowsCounts.firstProfessionCount,
          finalProfessionCount: vowsCounts.finalProfessionCount,
          priest: sumGroupedCount(memberCounts, "member_type_code", "member_type_code", memberTypeMap, "priest"),
          "religious brother": sumGroupedCount(memberCounts, "member_type_code", "member_type_code", memberTypeMap, "religious brother"),
          novoices: sumGroupedCount(scholasticCounts, "scholastic_type_code", "scholastic_type_code", scholasticTypeMap, "novoices"),
          minor_seminarians: sumGroupedCount(scholasticCounts, "scholastic_type_code", "scholastic_type_code", scholasticTypeMap, "minor seminarians"),
          ...apostolateCounts,
          ...aggregatedCounts,
      });
  } catch (error) {
      console.error("Error fetching aggregated concretion counts:", error);
      res.status(500).json({ message: "Failed to fetch aggregated concretion counts." });
  }
};




  
// export const getDivisionCountsforTokenConcretion = async (req, res) => {
//   try {
//       const authHeader = req.headers.authorization;
//       let concretion_code;
//       let role_name;

//       if (authHeader && authHeader.startsWith("Bearer ")) {
//           const token = authHeader.split(" ")[1];
//           const decoded = jwt.verify(token, JWT_SECRET);

//           role_name = decoded.role_name.toLowerCase();
//           concretion_code = decoded.concretion_code;
//       }

//       if (!role_name) {
//           return res.status(403).json({ error: "Role name not found in token." });
//       }
//       if (role_name !== "congregation admin") {
//           return res.status(403).json({ error: "Access denied for this role." });
//       }
//       if (!concretion_code) {
//           return res.status(400).json({ error: "Concretion code is required." });
//       }

//       const concretion = await prisma.concretion_defination_mst.findFirst({
//           where: { concretion_code },
//           select: { concretion_name: true },
//       });

//       if (!concretion) {
//           return res.status(404).json({ error: "Concretion not found." });
//       }

//       const provinces = await prisma.province_mst.findMany({
//           where: { concretion_code },
//           select: { province_code: true },
//       });

//       if (provinces.length === 0) {
//           return res.status(404).json({ error: "No provinces found for this concretion." });
//       }

//       const provinceCodes = provinces.map((p) => p.province_code);

//       // Apostolate quick codes
//       const apostolateQuickcodes = await prisma.quickcode_mst.findMany({
//           where: {
//               quick_code_type: "apostl",
//               quickcode_name: { in: ["Mission", "Formation", "Education", "SAIM"], mode: "insensitive" },
//           },
//           select: { quick_code: true, quickcode_name: true },
//       });

//       const apostolateTypeMap = Object.fromEntries(
//           apostolateQuickcodes.map((q) => [q.quick_code.toLowerCase(), q.quickcode_name.toLowerCase()])
//       );

//       // Initialize result structure for apostolates
//       const apostolateCounts = {};

//       // Fetch apostolates for the valid types
//       const apostolates = await prisma.apostolates_mst.findMany({
//           where: {
//               province_code: { in: provinceCodes },
//               apostolate_code: { in: Object.keys(apostolateTypeMap) },
//           },
//           select: {
//               apostolate_code: true,
//               centre_type_code: true,
//               centre_type_name: true,
//           },
//       });

//       // Process the combinations of apostolate type and center type
//       for (const apostolate of apostolates) {
//           const apostolateType = apostolateTypeMap[apostolate.apostolate_code.toLowerCase()];
//           if (!apostolateType) continue;

//           if (!apostolateCounts[apostolateType]) {
//               apostolateCounts[apostolateType] = {};
//           }

//           // Count entries in the `centre_dtl` table matching the current combination
//           const centreCount = await prisma.centre_dtl.count({
//               where: {
//                   province_code: { in: provinceCodes },
//                   apostolate_code: apostolate.apostolate_code,
//                   centre_type_code: apostolate.centre_type_code,
//               },
//           });

//           if (centreCount >= 1) {
//               apostolateCounts[apostolateType][apostolate.centre_type_name] = centreCount;
//           }

//           if (!apostolateCounts[apostolateType].diocse) {
//               const diocseCount = await prisma.centre_dtl.count({
//                   where: {
//                       province_code: { in: provinceCodes },
//                       apostolate_code: apostolate.apostolate_code,
//                       diocese_code: { not: "" }, // Ensure diocese_code exists
//                   },
//               });

//               apostolateCounts[apostolateType].diocse = diocseCount;
//           }
//       }

//       // Add other counts here (promotion, member types, scholastics, etc.)
//       // Simplified for brevity, assuming they are implemented correctly already

//       res.json({
//           concretion_code,
//           concretion_name: concretion.concretion_name,
//           role_name,
//           ...apostolateCounts,
//           // Add other counts here if necessary
//       });
//   } catch (error) {
//       console.error("Error fetching aggregated concretion counts:", error);
//       res.status(500).json({ message: "Failed to fetch aggregated concretion counts." });
//   }
// };


export const getProvincesForTokenConcretion = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let concretionCode,concretionName;

    // Validate the JWT and extract concretion_code
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, JWT_SECRET);

      concretionCode = decoded.concretion_code; // Extract concretion_code from token
    }

    if (!concretionCode) {
      return res.status(403).json({ error: "Unauthorized: Concretion code is missing." });
    }

    const concretion = await prisma.concretion_defination_mst.findFirst({
      where: { concretion_code: concretionCode },
      select: { concretion_name: true },
    });

    if (!concretion) {
      return res.status(404).json({ error: "Concretion not found for this token." });
    }

    concretionName = concretion.concretion_name;

    // Fetch all provinces for the concretion_code
    const provinces = await prisma.province_mst.findMany({
      where: {
        concretion_code: concretionCode,
      },
      select: {
        province_code: true,
        province_name: true,
        short_name: true,
        email: true,
        created_date: true,
      },
    });

    res.json({
      concretion_code: concretionCode,
      concretion_name: concretionName,
      provinces,
    });
  } catch (error) {
    console.error("Error fetching provinces for concretion:", error);
    res.status(500).json({ message: "Failed to fetch provinces." });
  }
};





